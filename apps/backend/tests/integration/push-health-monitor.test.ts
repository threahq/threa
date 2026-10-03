/**
 * The monitor's push probe (scripts/monitor/probes/push.ts) against the real
 * schema, through the real db-read-proxy executor (READ ONLY transaction, row
 * cap). Fleet-wide aggregates, so it runs in its own database. Rows are written
 * through the push repositories; only their timestamps are moved back
 * afterwards to place them in closed windows.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { createHash, randomBytes } from "node:crypto"
import type { Pool } from "pg"
import {
  ANALYTICS_CONSENT_GRANTED,
  ANALYTICS_CONSENT_KEY,
  PUSH_RECEIPT_STAGES,
  type PushProviderOutcome,
  type PushReceiptStage,
} from "@threahq/types"
import { DisabledAnalyticsReporter } from "@threahq/backend-common"
import { setupIsolatedTestDatabase } from "./setup"
import {
  PushDeliveryRepository,
  PushReceiptRepository,
  PushService,
  PushSubscriptionRepository,
  PushTelemetry,
  type PushSubscription,
} from "../../src/features/push"
import type { TerminalPushDeliveryStatus } from "../../src/features/push/delivery-repository"
import {
  decideSettlement,
  PUSH_INFRASTRUCTURE_FAILURE,
  PUSH_MAX_ABANDONED_CLAIMS,
} from "../../src/features/push/retry-policy"
import { E2eStreamsRepository } from "../../src/features/e2e-streams"
import { UserPreferencesRepository, UserPreferencesService } from "../../src/features/user-preferences"
import { streamId as newStreamId, userId as newUserId, workspaceId as newWorkspaceId } from "../../src/lib/id"
import { executeReadOnly } from "../../../db-read-proxy/src/query"
import { ReadProxyClient } from "../../../../scripts/monitor/db"
import { probePush, type ReceiptCohort } from "../../../../scripts/monitor/probes/push"
import { makeWindow } from "../../../../scripts/monitor/types"

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const LEASE_MS = 60_000

let nextEventId = BigInt(Date.now()) * 1000n

const hash = (token: string) => createHash("sha256").update(token).digest("hex")

const noExclusions = (): ReceiptCohort["excluded"] => ({
  revoked: 0,
  not_accepted: 0,
  unarmed_send: 0,
  consent: 0,
  policy: 0,
  endpoint_unknown: 0,
  collapsed: 0,
  collapse_uncertain: 0,
})

/** push-durable-delivery's renewLease, verbatim: a replica that predates send recording. */
const OLD_REPLICA_RENEW_LEASE = `
  UPDATE push_deliveries SET
    lease_expires_at = NOW() + ($1 * INTERVAL '1 millisecond'),
    updated_at = NOW()
  WHERE id = $2
    AND workspace_id = $3
    AND version = $4
    AND status = 'pending'`

/** This stack's renewLease before it recorded the endpoint: every sent_* column but the hash. */
const PRE_ENDPOINT_RENEW_LEASE = `
  UPDATE push_deliveries SET
    lease_expires_at = NOW() + ($1 * INTERVAL '1 millisecond'),
    sent_topic = $5::text,
    sent_with_receipt = $6::boolean,
    sent_claim_version = $4::int,
    sent_at = NOW(),
    updated_at = NOW()
  WHERE id = $2
    AND workspace_id = $3
    AND version = $4
    AND status = 'pending'`

describe("monitor push probe", () => {
  let pool: Pool
  let cleanup: () => Promise<void>
  let proxy: ReadProxyClient
  let anchor: Date
  const ws = newWorkspaceId()

  beforeAll(async () => {
    const isolated = await setupIsolatedTestDatabase("push_health_monitor")
    pool = isolated.pool
    cleanup = isolated.cleanup
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { sql: string; params: unknown[] }
      const result = await executeReadOnly(body, { pool, statementTimeoutMs: 5_000, maxRows: 5_000 })
      return new Response(JSON.stringify(result), { status: 200 })
    }) as typeof fetch
    proxy = new ReadProxyClient("http://read-proxy.test", "unused", fetchImpl)
  })

  afterAll(async () => {
    await cleanup()
  })

  beforeEach(async () => {
    await pool.query(
      "TRUNCATE push_receipts, push_deliveries, push_delivery_plans, push_subscriptions, user_preference_overrides, streams, e2e_streams"
    )
    anchor = (await pool.query<{ now: Date }>("SELECT NOW() AS now")).rows[0]!.now
  })

  const probe = () => {
    const now = new Date()
    return probePush(proxy, makeWindow(new Date(now.getTime() - HOUR_MS), now, 30 * MINUTE_MS, "test"))
  }

  async function user(consent: "granted" | "denied" | null): Promise<string> {
    const id = newUserId()
    if (consent) await UserPreferencesRepository.setOverride(pool, ws, id, ANALYTICS_CONSENT_KEY, consent)
    return id
  }

  const currentGrant = (uid: string) =>
    UserPreferencesRepository.findOverrideGeneration(pool, ws, uid, ANALYTICS_CONSENT_KEY, ANALYTICS_CONSENT_GRANTED)

  async function setConsent(uid: string, consent: "granted" | "denied" | null) {
    if (consent === null) await UserPreferencesRepository.bulkDeleteOverrides(pool, ws, uid, [ANALYTICS_CONSENT_KEY])
    else await UserPreferencesRepository.setOverride(pool, ws, uid, ANALYTICS_CONSENT_KEY, consent)
  }

  /**
   * The grant a receipt is armed under: the user's current one. A user without
   * one is granted for the arming and then put back, as a later withdrawal
   * would, so every receipt row carries a real generation.
   */
  async function armingGrant(uid: string): Promise<string> {
    const current = await currentGrant(uid)
    if (current !== null) return current
    const prior = await UserPreferencesRepository.findOverride(pool, ws, uid, ANALYTICS_CONSENT_KEY)
    await setConsent(uid, "granted")
    const grant = (await currentGrant(uid))!
    await setConsent(uid, (prior?.value as "granted" | "denied" | undefined) ?? null)
    return grant
  }

  /** Receipt ingest as the route runs it: real consent and root checks. */
  function ingest() {
    const preferences = new UserPreferencesService(pool)
    const unused = async (): Promise<never> => {
      throw new Error("not used by receipt ingest")
    }
    return new PushService({
      pool,
      vapidConfig: null,
      telemetry: new PushTelemetry({ reporter: new DisabledAnalyticsReporter() }),
      lookups: {
        getUserPushPreferences: unused,
        isNotificationPaused: unused,
        getStreamType: unused,
        getWorkosUserId: unused,
        resolveActivityPush: unused,
        resolveFiredReminder: unused,
        isRewrapOutstanding: unused,
        findAnalyticsConsentGrant: (db, workspaceId, uid) =>
          preferences.findAnalyticsConsentGrant(db, workspaceId, uid),
        isE2eRootedStream: async (db, workspaceId, streamId) =>
          (await E2eStreamsRepository.excludeE2eRootedStreamIds(db, [{ workspaceId, streamId }])).length === 0,
      },
    })
  }

  /** The raw token each delivery's receipt was last armed with. */
  const tokens = new Map<string, string>()

  async function stream(opts: { rootId?: string } = {}): Promise<string> {
    const id = newStreamId()
    await pool.query(
      "INSERT INTO streams (id, workspace_id, type, visibility, created_by, root_stream_id) VALUES ($1, $2, $3, 'private', 'usr_x', $4)",
      [id, ws, opts.rootId ? "thread" : "channel", opts.rootId ?? null]
    )
    return id
  }

  /** `browser`: another account's registration on the same browser, so the same endpoint and keys. */
  async function subscribe(uid: string, browser?: PushSubscription) {
    return PushSubscriptionRepository.insert(pool, {
      workspaceId: ws,
      userId: uid,
      endpoint: browser?.endpoint ?? `https://push.example/${randomBytes(8).toString("hex")}`,
      p256dh: browser?.p256dh ?? randomBytes(65).toString("base64url"),
      auth: browser?.auth ?? randomBytes(16).toString("base64url"),
      deviceKey: "device-1",
    })
  }

  /**
   * The same browser registration re-registered after a browser update: only the
   * UA-derived device key changes, so the generation advances while the endpoint,
   * which is all the push service replaces by, stays the same.
   */
  async function reregister(sub: PushSubscription) {
    const next = await PushSubscriptionRepository.insert(pool, {
      workspaceId: ws,
      userId: sub.userId,
      endpoint: sub.endpoint,
      p256dh: sub.p256dh,
      auth: sub.auth,
      deviceKey: "device-2",
    })
    expect({ id: next.id, advanced: next.generation > sub.generation }).toEqual({ id: sub.id, advanced: true })
    return next
  }

  interface SendOpts {
    uid: string
    sub: { id: string; generation: number; endpoint: string }
    streamId?: string | null
    topic?: string | null
    /** The accepted attempt carried a capability (default). `earlier`: only a failed earlier attempt did. */
    armed?: boolean | "earlier"
    /** An earlier failed attempt carried its own capability, and the device reported these stages with it before the retry re-armed. */
    retriedAfter?: PushReceiptStage[]
    /**
     * Record what was sent (default). false sends the accepting attempt through the pre-recording
     * renewal, `without-endpoint` through the renewal that recorded everything but the endpoint.
     */
    recorded?: boolean | "without-endpoint"
    /** Final status; `suppressed` settles without reaching a send. */
    status?: TerminalPushDeliveryStatus
    abandonBeforeSend?: boolean
    stages?: PushReceiptStage[]
    revoke?: boolean
    /** Runs once the delivery settled, while its capability is still live. */
    onSettled?: (deliveryId: string) => Promise<void>
    createdAgoMs?: number
    /** When the recorded send passed its ownership check, and when the row settled, after creation. */
    sentAfterMs?: number
    settledAfterMs?: number
  }

  /** One device delivery through the real start/record/settle path, then moved back in time. */
  async function send(opts: SendOpts): Promise<string> {
    const planned = await PushDeliveryRepository.insertPlan(pool, {
      workspaceId: ws,
      userId: opts.uid,
      kind: "activity",
      sourceEventId: (nextEventId += 1n),
      sourceId: `activity_${randomBytes(6).toString("hex")}`,
      sourceGeneration: null,
      sourceCreatedAt: new Date(),
      expiresAt: new Date(Date.now() + 24 * HOUR_MS),
      subscriptions: [opts.sub],
    })
    const deliveryId = planned!.devices[0]!.id
    let token = randomBytes(16).toString("hex")
    const row = { workspaceId: ws, deliveryId }
    const arm = async () => {
      token = randomBytes(16).toString("hex")
      tokens.set(deliveryId, token)
      const rotated = await PushReceiptRepository.armDelivery(pool, {
        workspaceId: ws,
        userId: opts.uid,
        deliveryId,
        subscriptionId: opts.sub.id,
        streamId: opts.streamId ?? null,
        tokenHash: hash(token),
        consentGeneration: await armingGrant(opts.uid),
        capabilityExpiresAt: new Date(Date.now() + HOUR_MS),
        retainUntil: new Date(Date.now() + 8 * 24 * HOUR_MS),
      })
      if (!rotated) throw new Error("the receipt was not armed")
    }
    const armed = opts.armed ?? true
    const topic = opts.topic === undefined ? randomBytes(4).toString("hex") : opts.topic

    let claimed = await PushDeliveryRepository.startAttempt(pool, { ...row, attempt: 0 })
    if (opts.abandonBeforeSend) {
      claimed = await PushDeliveryRepository.startAttempt(pool, { ...row, attempt: 0 })
    }
    if (opts.retriedAfter) {
      await arm()
      await PushDeliveryRepository.recordSend(pool, {
        ...row,
        version: claimed!.version,
        sent: { topic, withReceipt: true, endpointHash: hash(opts.sub.endpoint) },
      })
      await PushDeliveryRepository.settle(pool, {
        ...row,
        version: claimed!.version,
        settlement: {
          kind: "retry",
          nextAttemptAt: new Date(Date.now() - 1_000),
          outcome: "unreachable",
          statusCode: null,
        },
      })
      for (const stage of opts.retriedAfter) {
        await PushReceiptRepository.recordStage(pool, { workspaceId: ws, tokenHash: hash(token), stage, reason: null })
      }
      claimed = await PushDeliveryRepository.startAttempt(pool, { ...row, attempt: 1 })
    }
    if (armed === "earlier") {
      await arm()
      await PushDeliveryRepository.recordSend(pool, {
        ...row,
        version: claimed!.version,
        sent: { topic, withReceipt: true, endpointHash: hash(opts.sub.endpoint) },
      })
      await PushDeliveryRepository.settle(pool, {
        ...row,
        version: claimed!.version,
        settlement: {
          kind: "retry",
          nextAttemptAt: new Date(Date.now() - 1_000),
          outcome: "unreachable",
          statusCode: null,
        },
      })
      claimed = await PushDeliveryRepository.startAttempt(pool, { ...row, attempt: 1 })
    } else if (armed) {
      await arm()
    }
    const status = opts.status ?? "accepted"
    if (status === "suppressed") {
      await PushDeliveryRepository.settle(pool, {
        ...row,
        version: claimed!.version,
        settlement: { kind: "terminal", status, attempted: false, outcome: null, statusCode: null, reason: "prefs" },
      })
    } else {
      if (opts.recorded === false) {
        await pool.query(OLD_REPLICA_RENEW_LEASE, [LEASE_MS, deliveryId, ws, claimed!.version])
      } else if (opts.recorded === "without-endpoint") {
        await pool.query(PRE_ENDPOINT_RENEW_LEASE, [LEASE_MS, deliveryId, ws, claimed!.version, topic, armed === true])
      } else {
        await PushDeliveryRepository.recordSend(pool, {
          ...row,
          version: claimed!.version,
          sent: { topic, withReceipt: armed === true, endpointHash: hash(opts.sub.endpoint) },
        })
      }
      await PushDeliveryRepository.settle(pool, {
        ...row,
        version: claimed!.version,
        settlement: decideSettlement({
          result: {
            outcome: status === "accepted" ? "accepted" : "rejected",
            statusCode: status === "accepted" ? 201 : 400,
            retryAfterMs: null,
          },
          attemptsBefore: claimed!.attempts,
          nowMs: Date.now(),
          deadline: new Date(Date.now() + HOUR_MS),
        }),
      })
    }
    await opts.onSettled?.(deliveryId)
    for (const stage of opts.stages ?? []) {
      await PushReceiptRepository.recordStage(pool, {
        workspaceId: ws,
        tokenHash: hash(token),
        stage,
        reason: stage === PUSH_RECEIPT_STAGES.SUPPRESSED ? "presence" : null,
      })
    }
    if (opts.revoke) {
      const { rows } = await pool.query<{ id: string }>("SELECT id FROM push_receipts WHERE delivery_id = $1", [
        deliveryId,
      ])
      await PushReceiptRepository.revoke(pool, { workspaceId: ws, id: rows[0]!.id, tokenHash: hash(token) })
    }
    await age(deliveryId, planned!.planId, opts)
    return deliveryId
  }

  /**
   * Place the delivery `createdAgoMs` before the anchor, its recorded send and
   * settle after that: expiry a day after creation, capability ten minutes later.
   */
  async function age(deliveryId: string, planId: string, opts: SendOpts) {
    const createdAt = new Date(anchor.getTime() - (opts.createdAgoMs ?? 30 * HOUR_MS))
    const at = (offsetMs: number) => new Date(createdAt.getTime() + offsetMs)
    const expiresAt = at(24 * HOUR_MS)
    await pool.query(
      `UPDATE push_deliveries SET created_at = $2, updated_at = $3::timestamptz,
              sent_at = CASE WHEN sent_at IS NULL THEN NULL ELSE $4::timestamptz END,
              accepted_at = CASE WHEN accepted_at IS NULL THEN NULL ELSE $3::timestamptz END
        WHERE id = $1`,
      [deliveryId, createdAt, at(opts.settledAfterMs ?? MINUTE_MS), at(opts.sentAfterMs ?? 30_000)]
    )
    await pool.query("UPDATE push_delivery_plans SET expires_at = $2 WHERE id = $1", [planId, expiresAt])
    await pool.query("UPDATE push_receipts SET capability_expires_at = $2 WHERE delivery_id = $1", [
      deliveryId,
      new Date(expiresAt.getTime() + 10 * MINUTE_MS),
    ])
  }

  test("should count only matured, current-consent, plaintext, newest-per-topic automatic deliveries, in both numerator and denominator", async () => {
    const granted = await user("granted")
    const denied = await user("denied")
    const unset = await user(null)
    const channel = await stream()
    const e2eRoot = await stream()
    await E2eStreamsRepository.markStreamE2e(pool, {
      streamId: e2eRoot,
      workspaceId: ws,
      ownerUserId: granted,
      ownerUserKeyId: "e2ek_owner",
    })
    const e2eThread = await stream({ rootId: e2eRoot })
    const fresh = async (overrides: Partial<SendOpts> = {}) =>
      send({ uid: granted, sub: await subscribe(overrides.uid ?? granted), streamId: channel, ...overrides })
    const { RECEIVED, NOTIFICATION_CREATED, SUPPRESSED } = PUSH_RECEIPT_STAGES

    // Eligible: received then created; created with the `received` report lost; suppressed; silent.
    await fresh({ stages: [RECEIVED, NOTIFICATION_CREATED] })
    await fresh({ stages: [NOTIFICATION_CREATED] })
    await fresh({ stages: [SUPPRESSED] })
    await fresh()

    // Excluded by current consent, current root policy (a missing root included), capability,
    // revocation, provider result.
    await fresh({ uid: denied, stages: [RECEIVED] })
    await fresh({ uid: unset, stages: [RECEIVED] })
    await fresh({ streamId: e2eThread, stages: [RECEIVED] })
    await fresh({ streamId: newStreamId(), stages: [RECEIVED] })
    await fresh({ streamId: await stream({ rootId: newStreamId() }), stages: [RECEIVED] })
    await fresh({ armed: "earlier" })
    await fresh({ stages: [RECEIVED], revoke: true })
    await fresh({ status: "rejected" })

    // A newer same-topic send on the same registration collapses the older one; the newer one stays.
    const burst = await subscribe(granted)
    await send({ uid: granted, sub: burst, streamId: channel, topic: "burst", stages: [RECEIVED] })
    await send({
      uid: granted,
      sub: burst,
      streamId: channel,
      topic: "burst",
      stages: [NOTIFICATION_CREATED],
      createdAgoMs: 30 * HOUR_MS - 2 * MINUTE_MS,
    })

    // A mention and a plain message for the same stream use different topics: neither collapses.
    const mixed = await subscribe(granted)
    await send({ uid: granted, sub: mixed, streamId: channel, topic: "stream" })
    await send({
      uid: granted,
      sub: mixed,
      streamId: channel,
      topic: "streamm",
      createdAgoMs: 30 * HOUR_MS - 2 * MINUTE_MS,
    })

    // The provider replaces by endpoint and topic, never by our generation: a re-registration
    // between two same-topic sends still collapses the older one.
    const rekeyed = await subscribe(granted)
    await send({ uid: granted, sub: rekeyed, streamId: channel, topic: "rekey" })
    await send({
      uid: granted,
      sub: await reregister(rekeyed),
      streamId: channel,
      topic: "rekey",
      armed: false,
      createdAgoMs: 30 * HOUR_MS - 2 * MINUTE_MS,
    })

    // A replacement that is not in the sample still counts: one without a receipt that has not
    // matured yet (a known later send).
    const outside = await subscribe(granted)
    await send({ uid: granted, sub: outside, streamId: channel, topic: "outside", stages: [RECEIVED] })
    await send({
      uid: granted,
      sub: outside,
      streamId: channel,
      topic: "outside",
      armed: false,
      createdAgoMs: 7 * HOUR_MS,
    })
    // Still open (capability not expired), and the previous matured window.
    await fresh({ stages: [RECEIVED], createdAgoMs: 20 * HOUR_MS })
    await fresh({ stages: [RECEIVED], createdAgoMs: 54 * HOUR_MS })

    // Explicit Send test rows share the table and are never an automatic cohort.
    const tested = await subscribe(granted)
    await PushReceiptRepository.insertTestDevices(pool, {
      workspaceId: ws,
      userId: granted,
      testId: "push_test_x",
      devices: [{ subscriptionId: tested.id, deviceKey: "device-1", userAgent: null, tokenHash: hash("test-token") }],
      capabilityExpiresAt: new Date(anchor.getTime() - HOUR_MS),
      retainUntil: new Date(anchor.getTime() + HOUR_MS),
    })

    const report = await probe()
    expect(report.receipts).toEqual({
      state: "measured",
      windowMs: 24 * HOUR_MS,
      current: {
        eligible: 7,
        confirmed: 4,
        created: 3,
        suppressed: 1,
        creationFailed: 0,
        excluded: {
          revoked: 1,
          not_accepted: 1,
          unarmed_send: 1,
          consent: 2,
          policy: 3,
          endpoint_unknown: 0,
          collapsed: 3,
          collapse_uncertain: 0,
        },
      },
      baseline: { eligible: 1, confirmed: 1, created: 0, suppressed: 0, creationFailed: 0, excluded: noExclusions() },
    })
    expect({ unavailable: report.unavailable, findings: report.findings }).toEqual({ unavailable: [], findings: [] })
  })

  test("should not count an accepted send from a replica that predates send recording, even after a recorded armed attempt", async () => {
    const granted = await user("granted")
    const channel = await stream()
    await send({ uid: granted, sub: await subscribe(granted), streamId: channel, armed: "earlier", recorded: false })

    const report = await probe()
    expect(report.receipts).toMatchObject({
      state: "measured",
      current: { eligible: 0, confirmed: 0, excluded: { ...noExclusions(), unarmed_send: 1 } },
    })
  })

  test("should keep the newest send of a same-topic burst and tell known replacements from unordered overlaps", async () => {
    const granted = await user("granted")
    const channel = await stream()
    const T = 30 * HOUR_MS
    const S = 1_000
    const on = async (topic: string) => ({ uid: granted, sub: await subscribe(granted), streamId: channel, topic })
    const { RECEIVED } = PUSH_RECEIPT_STAGES

    // Tight burst: the older send settled before the newer one was sent. The older one is known to be
    // followed by an accepted same-topic send; the newer one is the burst's newest and stays eligible.
    const burst = await on("burst")
    await send({ ...burst, createdAgoMs: T, sentAfterMs: 30 * S, settledAfterMs: 60 * S })
    await send({ ...burst, createdAgoMs: T - 45 * S, sentAfterMs: 30 * S, settledAfterMs: 45 * S, stages: [RECEIVED] })

    // Same instant: the older one settled in the same database instant the newer one passed its check.
    const instant = await on("instant")
    await send({ ...instant, createdAgoMs: T, sentAfterMs: 30 * S, settledAfterMs: 60 * S })
    await send({ ...instant, createdAgoMs: T - 10 * S, sentAfterMs: 50 * S, settledAfterMs: 80 * S })

    // Overlapping sends: provider order is unknown, so both are uncertain rather than either one missed.
    const overlap = await on("overlap")
    await send({ ...overlap, createdAgoMs: T, sentAfterMs: 30 * S, settledAfterMs: 60 * S })
    await send({ ...overlap, createdAgoMs: T - 20 * S, sentAfterMs: 30 * S, settledAfterMs: 60 * S })

    // The same overlap across a re-registration: the endpoint did not change, so neither is known either.
    const rekeyed = await on("rekeyed")
    await send({ ...rekeyed, createdAgoMs: T, sentAfterMs: 30 * S, settledAfterMs: 60 * S })
    await send({
      ...rekeyed,
      sub: await reregister(rekeyed.sub),
      createdAgoMs: T - 20 * S,
      sentAfterMs: 30 * S,
      settledAfterMs: 60 * S,
    })

    // A newer same-topic send that the provider rejected outright, or that never reached a send,
    // replaced nothing.
    const rejected = await on("rejected")
    await send({ ...rejected, createdAgoMs: T, sentAfterMs: 30 * S, settledAfterMs: 60 * S })
    await send({ ...rejected, armed: false, status: "rejected", createdAgoMs: T - 20 * S })
    const unsent = await on("unsent")
    await send({ ...unsent, createdAgoMs: T, sentAfterMs: 30 * S, settledAfterMs: 60 * S })
    await send({ ...unsent, armed: false, status: "suppressed", createdAgoMs: T - 20 * S })

    const report = await probe()
    expect(report.receipts).toMatchObject({
      state: "measured",
      current: {
        eligible: 4,
        confirmed: 1,
        excluded: { ...noExclusions(), collapsed: 2, collapse_uncertain: 4 },
      },
    })
  })

  test("should collapse by the endpoint a send went to, whichever subscription row sent it", async () => {
    const alice = await user("granted")
    const bob = await user("granted")
    const channel = await stream()
    const T = 30 * HOUR_MS
    const S = 1_000
    const older = { streamId: channel, createdAgoMs: T, sentAfterMs: 30 * S, settledAfterMs: 60 * S }
    const newer = { streamId: channel, createdAgoMs: T - 45 * S, sentAfterMs: 30 * S, settledAfterMs: 45 * S }
    const overlapping = { streamId: channel, createdAgoMs: T - 20 * S, sentAfterMs: 30 * S, settledAfterMs: 60 * S }

    // Two accounts in one browser: one endpoint, a row each, and topics carry no recipient. Bob's
    // later accepted send replaced Alice's, whether or not hers reported.
    for (const stages of [[PUSH_RECEIPT_STAGES.RECEIVED], []]) {
      const browser = await subscribe(alice)
      const topic = randomBytes(4).toString("hex")
      await send({ uid: alice, sub: browser, topic, stages, ...older })
      await send({ uid: bob, sub: await subscribe(bob, browser), topic, ...newer })
    }

    // Opt-out and re-enable: the row is deleted and inserted again under a new id, same endpoint.
    const optedOut = await subscribe(alice)
    await send({ uid: alice, sub: optedOut, topic: "reenabled", ...older })
    await PushSubscriptionRepository.deleteByEndpoint(pool, ws, alice, optedOut.endpoint)
    const reenabled = await subscribe(alice, optedOut)
    await send({ uid: alice, sub: reenabled, topic: "reenabled", ...newer })

    // Overlapping sends from two accounts in one browser: provider order unknown, both uncertain.
    const shared = await subscribe(alice)
    await send({ uid: alice, sub: shared, topic: "overlap", ...older })
    await send({ uid: bob, sub: await subscribe(bob, shared), topic: "overlap", ...overlapping })

    // Co-recipients on their own browsers share the topic, not the endpoint: nothing is replaced.
    await send({ uid: alice, sub: await subscribe(alice), topic: "channel", ...older })
    await send({ uid: bob, sub: await subscribe(bob), topic: "channel", ...overlapping })

    const report = await probe()
    expect({ newRow: reenabled.id !== optedOut.id, receipts: report.receipts }).toMatchObject({
      newRow: true,
      receipts: {
        state: "measured",
        current: { eligible: 5, excluded: { ...noExclusions(), collapsed: 3, collapse_uncertain: 2 } },
      },
    })
  })

  test("should never count a delivery eligible while a send that may have replaced it has no recorded endpoint", async () => {
    const alice = await user("granted")
    const bob = await user("granted")
    const channel = await stream()
    const T = 30 * HOUR_MS
    const S = 1_000
    const at = (createdAgoMs: number) => ({
      streamId: channel,
      createdAgoMs,
      sentAfterMs: 30 * S,
      settledAfterMs: 60 * S,
    })
    const rival = (createdAgoMs: number) => ({ uid: bob, armed: false, ...at(createdAgoMs - 20 * S) })

    // Another row's send from a replica that recorded nothing: endpoint and topic unknown, and it
    // overlaps, so it may be the same browser. It only reaches deliveries it overlaps.
    await send({ uid: alice, sub: await subscribe(alice), topic: "unrecorded", ...at(T) })
    await send({ ...rival(T), sub: await subscribe(bob), recorded: false })

    // A replica that recorded the topic but not the endpoint: uncertain on the same topic only.
    await send({ uid: alice, sub: await subscribe(alice), topic: "same", ...at(T - 20 * MINUTE_MS) })
    await send({ ...rival(T - 20 * MINUTE_MS), sub: await subscribe(bob), topic: "same", recorded: "without-endpoint" })
    await send({ uid: alice, sub: await subscribe(alice), topic: "mine", ...at(T - 40 * MINUTE_MS) })
    await send({
      ...rival(T - 40 * MINUTE_MS),
      sub: await subscribe(bob),
      topic: "theirs",
      recorded: "without-endpoint",
    })

    // The delivery's own endpoint unknown: nothing can show what replaced it. Without a topic nothing can.
    const recordedWithoutEndpoint = { uid: alice, recorded: "without-endpoint" } as const
    await send({ ...recordedWithoutEndpoint, sub: await subscribe(alice), topic: "own", ...at(T - 60 * MINUTE_MS) })
    await send({ ...recordedWithoutEndpoint, sub: await subscribe(alice), topic: null, ...at(T - 80 * MINUTE_MS) })

    const report = await probe()
    expect(report.receipts).toMatchObject({
      state: "measured",
      current: { eligible: 2, excluded: { ...noExclusions(), endpoint_unknown: 1, collapse_uncertain: 2 } },
    })
  })

  test("should exclude overlapping workspace deliveries when an abandoned claim leaves send history unknown", async () => {
    const alice = await user("granted")
    const bob = await user("granted")
    const channel = await stream()
    const timing = { streamId: channel, createdAgoMs: 30 * HOUR_MS, sentAfterMs: 30_000, settledAfterMs: 60_000 }
    for (const stages of [[PUSH_RECEIPT_STAGES.RECEIVED], []]) {
      await send({ uid: alice, sub: await subscribe(alice), stages, ...timing })
    }
    const rivalId = await send({
      uid: bob,
      sub: await subscribe(bob),
      ...timing,
      createdAgoMs: timing.createdAgoMs - 20_000,
      armed: false,
      status: "suppressed",
      abandonBeforeSend: true,
    })
    const { rows } = await pool.query(
      "SELECT version, attempts, sent_endpoint_hash, sent_claim_version FROM push_deliveries WHERE workspace_id = $1 AND id = $2",
      [ws, rivalId]
    )
    const report = await probe()
    expect({ rival: rows[0], receipts: report.receipts }).toMatchObject({
      rival: { version: 3, attempts: 0, sent_endpoint_hash: null, sent_claim_version: null },
      receipts: {
        state: "measured",
        current: { eligible: 0, confirmed: 0, excluded: { ...noExclusions(), collapse_uncertain: 2 } },
      },
    })
  })

  test("should warn end to end when a matured cohort with a sample goes unconfirmed", async () => {
    const granted = await user("granted")
    for (let i = 0; i < 30; i++) await send({ uid: granted, sub: await subscribe(granted) })
    const report = await probe()
    expect(report.findings.map((finding) => finding.id)).toEqual(["push.receipts.shortfall"])
  })

  test("should count terminal device outcomes by settle time and leave in-flight pending rows to the backlog gauge", async () => {
    const uid = await user(null)
    const row = (deliveryId: string) => ({ workspaceId: ws, deliveryId })
    const plan = async () => {
      const sub = await subscribe(uid)
      const planned = await PushDeliveryRepository.insertPlan(pool, {
        workspaceId: ws,
        userId: uid,
        kind: "saved_reminder",
        sourceEventId: (nextEventId += 1n),
        sourceId: "saved_x",
        sourceGeneration: 1,
        sourceCreatedAt: new Date(),
        expiresAt: new Date(Date.now() + 24 * HOUR_MS),
        subscriptions: [sub],
      })
      return planned!.devices[0]!.id
    }
    /** One provider attempt settled by the production retry policy; retries come due at once. */
    const provider = async (
      deliveryId: string,
      attempt: number,
      outcome: PushProviderOutcome,
      opts: { windowClosing?: boolean } = {}
    ) => {
      const claimed = await PushDeliveryRepository.startAttempt(pool, { ...row(deliveryId), attempt })
      const nowMs = Date.now() - HOUR_MS
      await PushDeliveryRepository.settle(pool, {
        ...row(deliveryId),
        version: claimed!.version,
        settlement: decideSettlement({
          result: { outcome, statusCode: outcome === "unreachable" ? 503 : null, retryAfterMs: null },
          attemptsBefore: claimed!.attempts,
          nowMs,
          deadline: new Date(nowMs + (opts.windowClosing ? 1_000 : 24 * HOUR_MS)),
        }),
      })
    }
    /** Settle without a send, as the worker does for suppression, expiry and infrastructure failure. */
    const unsent = async (deliveryId: string, attempt: number, status: TerminalPushDeliveryStatus, reason: string) => {
      const claimed = await PushDeliveryRepository.startAttempt(pool, { ...row(deliveryId), attempt })
      return PushDeliveryRepository.settle(pool, {
        ...row(deliveryId),
        version: claimed!.version,
        settlement: { kind: "terminal", status, attempted: false, outcome: null, statusCode: null, reason },
      })
    }
    /** A start that never settles, as after a crash. */
    const abandon = async (deliveryId: string, attempt: number) => {
      await PushDeliveryRepository.startAttempt(pool, { workspaceId: ws, deliveryId, attempt })
    }

    await provider(await plan(), 0, "accepted")
    const retriedThenAccepted = await plan()
    await provider(retriedThenAccepted, 0, "unreachable")
    await provider(retriedThenAccepted, 1, "accepted")
    await provider(await plan(), 0, "rejected")
    await provider(await plan(), 0, "invalid_registration")
    await provider(await plan(), 0, "registration_gone")
    const exhausted = await plan()
    for (let attempt = 0; attempt < 5; attempt++) await provider(exhausted, attempt, "unreachable")
    await provider(await plan(), 0, "unreachable", { windowClosing: true })
    const expiredBeforeRetry = await plan()
    await provider(expiredBeforeRetry, 0, "unreachable")
    await unsent(expiredBeforeRetry, 1, "expired", "expired")
    // A transient provider answer, then claims that never settle: the worker, not the provider, failed it.
    const abandonedAfterTransient = await plan()
    await provider(abandonedAfterTransient, 0, "unreachable")
    for (let i = 0; i < PUSH_MAX_ABANDONED_CLAIMS; i++) await abandon(abandonedAfterTransient, 1)
    expect(await unsent(abandonedAfterTransient, 1, "failed", PUSH_INFRASTRUCTURE_FAILURE)).toMatchObject({
      status: "failed",
      attempts: 1,
    })
    await unsent(await plan(), 0, "suppressed", "prefs")
    await unsent(await plan(), 0, "failed", PUSH_INFRASTRUCTURE_FAILURE)
    const earlier = await plan()
    await provider(earlier, 0, "accepted")
    await pool.query("UPDATE push_deliveries SET updated_at = NOW() - interval '90 minutes' WHERE id = $1", [earlier])

    // Pending: one overdue retry, one started and sending right now.
    await provider(await plan(), 0, "unreachable")
    const inFlight = await plan()
    const claimed = await PushDeliveryRepository.startAttempt(pool, { ...row(inFlight), attempt: 0 })
    await PushDeliveryRepository.recordSend(pool, {
      ...row(inFlight),
      version: claimed!.version,
      sent: { topic: null, withReceipt: false, endpointHash: hash("in-flight") },
    })

    const report = await probe()
    expect({ outcomes: report.outcomes, findings: report.findings.map((finding) => finding.id) }).toEqual({
      outcomes: {
        since: {
          accepted: 2,
          rejected: 2,
          unreachable: 2,
          registrationGone: 1,
          workerFailed: 2,
          notSent: 2,
          retried: 2,
        },
        prior: {
          accepted: 1,
          rejected: 0,
          unreachable: 0,
          registrationGone: 0,
          workerFailed: 0,
          notSent: 0,
          retried: 0,
        },
      },
      findings: ["push.worker_failed", "push.backlog"],
    })
    expect(report.backlog).toEqual({ pending: 2, retrying: 1, overdue: 1, oldestDueSec: expect.any(Number) })
    expect(report.backlog!.oldestDueSec!).toBeGreaterThanOrEqual(10 * 60 - 5)
  })

  test("should keep a retried delivery in the same class whether or not the device reported its first attempt", async () => {
    const granted = await user("granted")
    const channel = await stream()
    const { RECEIVED, NOTIFICATION_CREATED } = PUSH_RECEIPT_STAGES
    const reported = await send({
      uid: granted,
      sub: await subscribe(granted),
      streamId: channel,
      retriedAfter: [RECEIVED, NOTIFICATION_CREATED],
    })
    const unreported = await send({ uid: granted, sub: await subscribe(granted), streamId: channel, retriedAfter: [] })
    const { rows } = await pool.query(
      `SELECT d.id, d.sent_with_receipt, r.received_at IS NOT NULL AS received, r.outcome
         FROM push_deliveries d JOIN push_receipts r ON r.delivery_id = d.id ORDER BY d.id = $1 DESC`,
      [reported]
    )

    const report = await probe()
    expect({ rows, receipts: report.receipts }).toEqual({
      rows: [
        { id: reported, sent_with_receipt: true, received: true, outcome: "notification_created" },
        { id: unreported, sent_with_receipt: true, received: false, outcome: null },
      ],
      receipts: {
        state: "measured",
        windowMs: 24 * HOUR_MS,
        current: {
          eligible: 2,
          confirmed: 1,
          created: 1,
          suppressed: 0,
          creationFailed: 0,
          excluded: noExclusions(),
        },
        baseline: expect.any(Object),
      },
    })
  })

  test("should exclude both deliveries of a withdrawn-then-regranted user whether or not one reported in between", async () => {
    const regranted = await user("granted")
    const channel = await stream()
    const grantAtArming = await currentGrant(regranted)
    await send({ uid: regranted, sub: await subscribe(regranted), streamId: channel })
    await send({
      uid: regranted,
      sub: await subscribe(regranted),
      streamId: channel,
      onSettled: async (deliveryId) => {
        await setConsent(regranted, "denied")
        await ingest().recordReceipt({
          workspaceId: ws,
          token: tokens.get(deliveryId)!,
          stage: PUSH_RECEIPT_STAGES.RECEIVED,
          reason: null,
        })
      },
    })
    await setConsent(regranted, "granted")

    const report = await probe()
    expect({ regrantIsNew: (await currentGrant(regranted)) !== grantAtArming, current: report.receipts }).toEqual({
      regrantIsNew: true,
      current: expect.objectContaining({
        current: expect.objectContaining({
          eligible: 0,
          confirmed: 0,
          excluded: { ...noExclusions(), revoked: 1, consent: 1 },
        }),
      }),
    })
  })

  test("should exclude a receipt armed before consent generations existed", async () => {
    const granted = await user("granted")
    const channel = await stream()
    const premetadata = await send({
      uid: granted,
      sub: await subscribe(granted),
      streamId: channel,
      stages: ["received"],
    })
    await pool.query("UPDATE push_receipts SET consent_generation = NULL WHERE delivery_id = $1", [premetadata])

    const report = await probe()
    expect(report.receipts).toMatchObject({
      state: "measured",
      current: { eligible: 0, confirmed: 0, excluded: { ...noExclusions(), consent: 1 } },
    })
  })

  test("should report missing schema as unavailable rather than as zeros", async () => {
    const gated = [
      ["push_deliveries", "sent_topic"],
      ["push_deliveries", "sent_with_receipt"],
      ["push_deliveries", "sent_claim_version"],
      ["push_deliveries", "sent_at"],
      ["push_deliveries", "sent_endpoint_hash"],
      ["push_receipts", "consent_generation"],
      ["user_preference_overrides", "value_generation"],
    ] as const
    const summary = async () => {
      const report = await probe()
      return {
        receipts: report.receipts.state,
        unavailable: report.unavailable.map((entry) => entry.part),
        outcomesMeasured: report.outcomes !== null,
      }
    }
    // Each column is hidden alone, so every one of them is proven to gate on its own.
    const missing: Record<string, unknown> = {}
    for (const [table, column] of gated) {
      await pool.query(`ALTER TABLE ${table} RENAME COLUMN ${column} TO ${column}_hidden`)
      try {
        missing[column] = await summary()
      } finally {
        await pool.query(`ALTER TABLE ${table} RENAME COLUMN ${column}_hidden TO ${column}`)
      }
    }
    const unavailable = { receipts: "unavailable", unavailable: ["receipts"], outcomesMeasured: true }
    expect({ missing, restored: await summary() }).toEqual({
      missing: Object.fromEntries(gated.map(([, column]) => [column, unavailable])),
      restored: { receipts: "measured", unavailable: [], outcomesMeasured: true },
    })

    await pool.query("DROP TABLE push_deliveries")
    const withoutLedger = await probe()
    expect({
      outcomes: withoutLedger.outcomes,
      backlog: withoutLedger.backlog,
      findings: withoutLedger.findings.map((finding) => finding.id),
    }).toEqual({
      outcomes: null,
      backlog: null,
      findings: ["push.unavailable.outcomes", "push.unavailable.receipts"],
    })
  })
})
