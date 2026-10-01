/**
 * Push receipt routes over real HTTP against the booted server: the token-only
 * receipt route (no cookie, its own capped parser ahead of the app-wide one,
 * Zod, no oracle) and the owner-only Send test poll.
 *
 * Run: bun test --preload ./tests/setup.ts tests/integration/push-receipts-http.test.ts
 */

import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { createHash, randomBytes } from "node:crypto"
import { Pool, type PoolClient } from "pg"
import { ANALYTICS_CONSENT_GRANTED, ANALYTICS_CONSENT_KEY, StreamTypes } from "@threahq/types"
import { DisabledAnalyticsReporter, addLogDestination, attachPostHogLogShipping, logger } from "@threahq/backend-common"
import { getTestDatabaseTarget } from "../test-database"
import { TestClient, createChannel, createWorkspace, getBaseUrl, joinWorkspace, loginAs } from "../client"
import { PushReceiptRepository } from "../../src/features/push"
import { AccessLogRepository } from "../../src/features/access-log"
import { E2eStreamsRepository } from "../../src/features/e2e-streams"
import { StreamRepository } from "../../src/features/streams"
import { UserPreferencesRepository } from "../../src/features/user-preferences"
import { pushDeliveryId, pushSubscriptionId, streamId } from "../../src/lib/id"

const HOUR_MS = 60 * 60 * 1000
const testRunId = Math.random().toString(36).slice(2, 8)

function newToken(): string {
  return randomBytes(32).toString("base64url")
}

function hashOf(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}

interface ReceiptState {
  receivedAt: Date | null
  outcome: string | null
  outcomeReason: string | null
  revokedAt: Date | null
  tokenHash: string | null
}

describe("push receipt routes", () => {
  let pool: Pool
  let owner: TestClient
  let other: TestClient
  let workspaceId: string
  let ownerUserId: string
  let channelId: string

  async function receiptState(id: string): Promise<ReceiptState> {
    const { rows } = await pool.query(
      `SELECT received_at, outcome, outcome_reason, revoked_at, token_hash FROM push_receipts WHERE id = $1`,
      [id]
    )
    const row = rows[0]
    return {
      receivedAt: row.received_at,
      outcome: row.outcome,
      outcomeReason: row.outcome_reason,
      revokedAt: row.revoked_at,
      tokenHash: row.token_hash,
    }
  }

  async function currentGrant(): Promise<string | null> {
    return UserPreferencesRepository.findOverrideGeneration(
      pool,
      ownerUserId,
      ANALYTICS_CONSENT_KEY,
      ANALYTICS_CONSENT_GRANTED
    )
  }

  /** Arm an automatic delivery receipt for the owner under their current grant; return its raw token and row id. */
  async function armDelivery(streamId: string | null = channelId): Promise<{ token: string; id: string }> {
    const token = newToken()
    const deliveryId = pushDeliveryId()
    const consentGeneration = await currentGrant()
    if (consentGeneration === null) throw new Error("owner has no consent grant to arm under")
    await PushReceiptRepository.armDelivery(pool, {
      workspaceId,
      userId: ownerUserId,
      deliveryId,
      subscriptionId: pushSubscriptionId(),
      streamId,
      tokenHash: hashOf(token),
      consentGeneration,
      capabilityExpiresAt: new Date(Date.now() + HOUR_MS),
      retainUntil: new Date(Date.now() + 24 * HOUR_MS),
    })
    const { rows } = await pool.query(`SELECT id FROM push_receipts WHERE delivery_id = $1`, [deliveryId])
    return { token, id: rows[0].id }
  }

  /** A raw POST with no cookie, the way a service worker of a parked account reports. */
  async function postReceipt(body: string, ws = workspaceId, contentType = "application/json") {
    const response = await fetch(`${getBaseUrl()}/api/workspaces/${ws}/push/receipts`, {
      method: "POST",
      headers: { "Content-Type": contentType },
      body,
    })
    return { status: response.status, text: await response.text() }
  }

  /** Whether some backend queues on a lock `holder` owns within a few seconds. */
  async function waitForLockWaiter(holder: PoolClient): Promise<boolean> {
    const { rows } = await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
    for (let i = 0; i < 100; i++) {
      const waiting = await pool.query(`SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))`, [
        rows[0]!.pid,
      ])
      if ((waiting.rowCount ?? 0) > 0) return true
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    return false
  }

  function report(token: string, stage: string, extra: Record<string, unknown> = {}) {
    return postReceipt(JSON.stringify({ token, stage, ...extra }))
  }

  async function setConsent(client: TestClient, analyticsConsent: "granted" | "denied") {
    const { status } = await client.request("PATCH", `/api/workspaces/${workspaceId}/preferences`, {
      analyticsConsent,
    })
    if (status !== 200) throw new Error(`preferences update failed: ${status}`)
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: getTestDatabaseTarget().connectionUrl })
    owner = new TestClient()
    other = new TestClient()
    const ownerEmail = `receipt-owner-${testRunId}@test.com`
    await loginAs(owner, ownerEmail, "Receipt Owner")
    workspaceId = (await createWorkspace(owner, `Receipts ${testRunId}`)).id
    const { rows } = await pool.query(`SELECT id FROM users WHERE workspace_id = $1 AND email = $2`, [
      workspaceId,
      ownerEmail,
    ])
    ownerUserId = rows[0].id
    await loginAs(other, `receipt-other-${testRunId}@test.com`, "Receipt Other")
    await joinWorkspace(other, workspaceId)
    channelId = (await createChannel(owner, workspaceId, `receipts-${testRunId}`, "public")).id
  })

  beforeEach(async () => {
    await setConsent(owner, "granted")
  })

  afterAll(async () => {
    await pool.end()
  })

  test("should record a consenting delivery receipt from the token alone, with no cookie", async () => {
    const { token, id } = await armDelivery()

    const result = await report(token, "received")

    expect(result.status).toBe(204)
    expect(await receiptState(id)).toMatchObject({ receivedAt: expect.any(Date), outcome: null, revokedAt: null })
  })

  test("should keep a created outcome whatever arrives after it, and let a created report replace an earlier failure or suppression", async () => {
    const createdFirst = await armDelivery()
    const failedFirst = await armDelivery()
    const suppressedFirst = await armDelivery()
    const stamps = async () =>
      (
        await pool.query<{ receivedStamp: string | null; outcomeStamp: string | null }>(
          `SELECT received_at::text AS "receivedStamp", outcome_at::text AS "outcomeStamp"
             FROM push_receipts WHERE id = $1`,
          [suppressedFirst.id]
        )
      ).rows[0]!

    const suppressedStatuses = [
      (await report(suppressedFirst.token, "received")).status,
      (await report(suppressedFirst.token, "suppressed", { reason: "presence" })).status,
    ]
    const whileSuppressed = { ...(await receiptState(suppressedFirst.id)), ...(await stamps()) }
    suppressedStatuses.push((await report(suppressedFirst.token, "notification_created")).status)
    const afterCreated = await stamps()
    const { rows: advanced } = await pool.query<{ advanced: boolean }>(
      "SELECT $1::timestamptz > $2::timestamptz AS advanced",
      [afterCreated.outcomeStamp, whileSuppressed.outcomeStamp]
    )

    const statuses = [
      (await report(createdFirst.token, "notification_created")).status,
      (await report(createdFirst.token, "received")).status,
      (await report(createdFirst.token, "creation_failed")).status,
      (await report(createdFirst.token, "suppressed", { reason: "presence" })).status,
      (await report(failedFirst.token, "creation_failed")).status,
      (await report(failedFirst.token, "suppressed", { reason: "presence" })).status,
      (await report(failedFirst.token, "notification_created")).status,
      (await report(failedFirst.token, "creation_failed")).status,
    ]

    const created = (tokenHash: string, receivedAt: unknown) => ({
      receivedAt,
      outcome: "notification_created",
      outcomeReason: null,
      revokedAt: null,
      tokenHash,
    })
    expect({
      statuses,
      createdFirst: await receiptState(createdFirst.id),
      failedFirst: await receiptState(failedFirst.id),
      suppressedStatuses,
      whileSuppressed: { outcome: whileSuppressed.outcome, outcomeReason: whileSuppressed.outcomeReason },
      suppressedFirst: await receiptState(suppressedFirst.id),
      receivedKept: afterCreated.receivedStamp === whileSuppressed.receivedStamp && afterCreated.receivedStamp !== null,
      outcomeAtAdvanced: advanced[0]!.advanced,
    }).toEqual({
      statuses: [204, 204, 204, 204, 204, 204, 204, 204],
      createdFirst: created(hashOf(createdFirst.token), expect.any(Date)),
      failedFirst: created(hashOf(failedFirst.token), null),
      suppressedStatuses: [204, 204, 204],
      whileSuppressed: { outcome: "suppressed", outcomeReason: "presence" },
      suppressedFirst: created(hashOf(suppressedFirst.token), expect.any(Date)),
      receivedKept: true,
      outcomeAtAdvanced: true,
    })
  })

  test("should record a suppression with its reason and drop a reason sent with any other stage", async () => {
    const suppressed = await armDelivery()
    const created = await armDelivery()

    await report(suppressed.token, "suppressed", { reason: "presence" })
    await report(created.token, "notification_created", { reason: "presence" })

    expect({
      suppressed: (await receiptState(suppressed.id)).outcomeReason,
      created: await receiptState(created.id),
    }).toEqual({
      suppressed: "presence",
      created: expect.objectContaining({ outcome: "notification_created", outcomeReason: null }),
    })
  })

  test("should answer 204 and change nothing for another workspace, an expired capability or an unknown token", async () => {
    const wrongWorkspace = await armDelivery()
    const expired = await armDelivery()
    await pool.query(`UPDATE push_receipts SET capability_expires_at = NOW() - INTERVAL '1 second' WHERE id = $1`, [
      expired.id,
    ])
    const { id: otherWs } = await createWorkspace(owner, `Receipts other ${testRunId}`)

    const statuses = [
      (await postReceipt(JSON.stringify({ token: wrongWorkspace.token, stage: "received" }), otherWs)).status,
      (await report(expired.token, "received")).status,
      (await report(newToken(), "received")).status,
    ]

    expect({
      statuses,
      wrongWorkspace: (await receiptState(wrongWorkspace.id)).receivedAt,
      expired: (await receiptState(expired.id)).receivedAt,
    }).toEqual({ statuses: [204, 204, 204], wrongWorkspace: null, expired: null })
  })

  test("should revoke rather than record a delivery receipt once analytics consent is withdrawn", async () => {
    const { token, id } = await armDelivery()
    await setConsent(owner, "denied")

    const first = await report(token, "notification_created")
    await setConsent(owner, "granted")
    const replay = await report(token, "notification_created")

    expect({ first: first.status, replay: replay.status, state: await receiptState(id) }).toEqual({
      first: 204,
      replay: 204,
      state: { receivedAt: null, outcome: null, outcomeReason: null, revokedAt: expect.any(Date), tokenHash: null },
    })
  })

  test("should revoke a receipt whose grant was withdrawn and given again before the report, and keep one whose grant was only rewritten", async () => {
    const regranted = await armDelivery()
    const rewritten = await armDelivery()
    const grantAtArming = await currentGrant()

    await setConsent(owner, "granted")
    const afterRewrite = await currentGrant()
    await report(rewritten.token, "received")
    await setConsent(owner, "denied")
    await setConsent(owner, "granted")
    await report(regranted.token, "received")

    expect({
      rewriteKeptGrant: afterRewrite === grantAtArming,
      regrantIsNew: (await currentGrant()) !== grantAtArming,
      rewritten: await receiptState(rewritten.id),
      regranted: await receiptState(regranted.id),
    }).toEqual({
      rewriteKeptGrant: true,
      regrantIsNew: true,
      rewritten: {
        receivedAt: expect.any(Date),
        outcome: null,
        outcomeReason: null,
        revokedAt: null,
        tokenHash: hashOf(rewritten.token),
      },
      regranted: { receivedAt: null, outcome: null, outcomeReason: null, revokedAt: expect.any(Date), tokenHash: null },
    })
  })

  test("should not record a delivery receipt when consent is withdrawn while the report is being checked", async () => {
    const { token, id } = await armDelivery()
    const withdrawal = await pool.connect()
    let reported: Promise<{ status: number }> | null = null
    let waitedOnWithdrawal = false
    try {
      await withdrawal.query("BEGIN")
      await UserPreferencesRepository.bulkSetOverrides(withdrawal, ownerUserId, [
        { key: "analyticsConsent", value: "denied" },
      ])
      reported = report(token, "notification_created")
      waitedOnWithdrawal = await waitForLockWaiter(withdrawal)
      await withdrawal.query("COMMIT")
    } catch (err) {
      await withdrawal.query("ROLLBACK")
      throw err
    } finally {
      withdrawal.release()
    }

    expect({ status: (await reported!).status, waitedOnWithdrawal, state: await receiptState(id) }).toEqual({
      status: 204,
      waitedOnWithdrawal: true,
      state: { receivedAt: null, outcome: null, outcomeReason: null, revokedAt: expect.any(Date), tokenHash: null },
    })
  })

  test("should revoke a delivery receipt whose stream's root became end-to-end encrypted after issuance", async () => {
    const scratchpad = (await createChannel(owner, workspaceId, `receipts-e2e-${testRunId}`, "private")).id
    const { token, id } = await armDelivery(scratchpad)
    await E2eStreamsRepository.markStreamE2e(pool, {
      streamId: scratchpad,
      workspaceId,
      ownerUserId,
      ownerUserKeyId: "e2ek_owner",
    })

    await report(token, "received")

    expect(await receiptState(id)).toMatchObject({ receivedAt: null, revokedAt: expect.any(Date), tokenHash: null })
  })

  test("should revoke a delivery receipt whose thread's root stream was removed after issuance", async () => {
    const rootId = (await createChannel(owner, workspaceId, `receipts-root-${testRunId}`, "public")).id
    const thread = await StreamRepository.insert(pool, {
      id: streamId(),
      workspaceId,
      type: StreamTypes.THREAD,
      parentStreamId: rootId,
      rootStreamId: rootId,
      createdBy: ownerUserId,
    })
    const { token, id } = await armDelivery(thread.id)
    await pool.query(`DELETE FROM streams WHERE workspace_id = $1 AND id = $2`, [workspaceId, rootId])

    await report(token, "notification_created")

    expect(await receiptState(id)).toEqual({
      receivedAt: null,
      outcome: null,
      outcomeReason: null,
      revokedAt: expect.any(Date),
      tokenHash: null,
    })
  })

  test("should record an explicit test receipt with analytics denied and show it only to the test's owner", async () => {
    await setConsent(owner, "denied")
    const testId = pushDeliveryId()
    const token = newToken()
    const subscriptionId = pushSubscriptionId()
    const legacySubscriptionId = pushSubscriptionId()
    await PushReceiptRepository.insertTestDevices(pool, {
      workspaceId,
      userId: ownerUserId,
      testId,
      devices: [
        { subscriptionId, deviceKey: "dev-new", userAgent: "UA new", tokenHash: hashOf(token) },
        { subscriptionId: legacySubscriptionId, deviceKey: "dev-old", userAgent: null, tokenHash: null },
      ],
      capabilityExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
      retainUntil: new Date(Date.now() + 24 * HOUR_MS),
    })
    await PushReceiptRepository.recordTestProviderOutcomes(pool, {
      workspaceId,
      testId,
      results: [
        { subscriptionId, outcome: "accepted", statusCode: 201 },
        { subscriptionId: legacySubscriptionId, outcome: "rejected", statusCode: 400 },
      ],
    })

    await report(token, "received")
    const path = `/api/workspaces/${workspaceId}/push/test/${testId}`
    const own = await owner.get(path)
    const foreign = await other.get(path)
    const missing = await owner.get(`/api/workspaces/${workspaceId}/push/test/${pushDeliveryId()}`)

    const expectedDevices = [
      {
        subscriptionId,
        deviceKey: "dev-new",
        userAgent: "UA new",
        outcome: "accepted",
        statusCode: 201,
        receipt: { expected: true, stage: "received", reason: null },
      },
      {
        subscriptionId: legacySubscriptionId,
        deviceKey: "dev-old",
        userAgent: null,
        outcome: "rejected",
        statusCode: 400,
        receipt: { expected: false, stage: null, reason: null },
      },
    ].sort((a, b) => a.subscriptionId.localeCompare(b.subscriptionId))
    expect({ own: own.status, body: own.data, foreign: foreign.status, missing: missing.status }).toEqual({
      own: 200,
      body: { testId, expiresAt: expect.any(String), devices: expectedDevices },
      foreign: 404,
      missing: 404,
    })
  })

  test("should stop showing a test once its reports expire, before cleanup deletes the rows, independent of its capability expiry", async () => {
    async function insertTest(retainUntil: Date) {
      const testId = pushDeliveryId()
      const subscriptionId = pushSubscriptionId()
      await PushReceiptRepository.insertTestDevices(pool, {
        workspaceId,
        userId: ownerUserId,
        testId,
        devices: [{ subscriptionId, deviceKey: "dev", userAgent: null, tokenHash: hashOf(newToken()) }],
        capabilityExpiresAt: new Date(Date.now() - 60 * 1000),
        retainUntil,
      })
      return { testId, subscriptionId }
    }
    const live = await insertTest(new Date(Date.now() + 24 * HOUR_MS))
    const expired = await insertTest(new Date(Date.now() - 60 * 1000))

    const liveRead = await owner.get<{ devices: Array<{ subscriptionId: string }> }>(
      `/api/workspaces/${workspaceId}/push/test/${live.testId}`
    )
    const expiredRead = await owner.get(`/api/workspaces/${workspaceId}/push/test/${expired.testId}`)
    const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM push_receipts WHERE test_id = $1`, [
      expired.testId,
    ])

    expect({
      live: { status: liveRead.status, devices: liveRead.data.devices.map((d) => d.subscriptionId) },
      expired: expiredRead.status,
      expiredRowsStillStored: rows[0].n,
    }).toEqual({
      live: { status: 200, devices: [live.subscriptionId] },
      expired: 404,
      expiredRowsStillStored: 1,
    })
  })

  test("should reject a malformed, unknown-stage, extra-field, oversized or unsupported-charset body without echoing it", async () => {
    const { token, id } = await armDelivery()
    const oversized = JSON.stringify({ token, stage: "received", padding: "x".repeat(4096) })

    const results = {
      malformed: await postReceipt(`{"token":"${token}",`),
      badStage: await report(token, "delivered"),
      badReason: await report(token, "suppressed", { reason: "because" }),
      extraField: await report(token, "received", { userId: ownerUserId }),
      shortToken: await report("abc", "received"),
      oversized: await postReceipt(oversized),
      unsupportedCharset: await postReceipt(
        JSON.stringify({ token, stage: "received" }),
        workspaceId,
        "application/json; charset=latin1"
      ),
    }

    expect(Object.fromEntries(Object.entries(results).map(([k, r]) => [k, r.status]))).toEqual({
      malformed: 400,
      badStage: 400,
      badReason: 400,
      extraField: 400,
      shortToken: 400,
      oversized: 413,
      unsupportedCharset: 400,
    })
    expect(Object.values(results).some((r) => r.text.includes(token))).toBe(false)
    expect((await receiptState(id)).receivedAt).toBeNull()
  })

  test("should log, ship and report push diagnostic failures anonymously, with analytics denied and a signed-in caller", async () => {
    await setConsent(owner, "denied")
    const testId = pushDeliveryId()
    const token = newToken()
    const secrets = {
      requestId: `req-${ownerUserId}`,
      userAgent: `Secret-Agent-${testRunId}`,
      failure: `connection lost for ${ownerUserId} at ${hashOf(token)}`,
    }
    const headers = { "X-Request-Id": secrets.requestId, "User-Agent": secrets.userAgent }
    const post = (path: string, body: string) =>
      fetch(`${getBaseUrl()}${path}`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body,
      })

    const lines: string[] = []
    addLogDestination({ level: "debug", stream: { write: (line: string) => void lines.push(line) } })
    const shipped: string[] = []
    const levelBefore = logger.level
    const shipper = attachPostHogLogShipping({
      config: { projectToken: "phc_test", host: "https://posthog.example.com", logsLevel: "debug" },
      service: "backend",
      region: null,
      environment: "test",
      flushIntervalMs: 50,
      fetchImpl: (async (_url: string, init: RequestInit) => {
        shipped.push(String(init.body))
        return new Response(null, { status: 200 })
      }) as unknown as typeof fetch,
    })!
    const failure = Object.assign(new Error(secrets.failure), { code: "57P01" })
    const exceptions = spyOn(DisabledAnalyticsReporter.prototype, "captureException")
    const findLive = spyOn(PushReceiptRepository, "findLive").mockRejectedValue(failure)
    const findTestProgress = spyOn(PushReceiptRepository, "findTestProgress").mockRejectedValue(failure)
    let statuses: Record<string, number>
    try {
      const receiptPath = `/api/workspaces/${workspaceId}/push/receipts`
      statuses = {
        malformed: (await post(receiptPath, `{"token":"${token}",`)).status,
        overlarge: (await post(receiptPath.toUpperCase(), JSON.stringify({ token, padding: "x".repeat(4096) }))).status,
        ingestFailure: (await post(receiptPath, JSON.stringify({ token, stage: "received" }))).status,
        progressFailure: (
          await owner.request("GET", `/api/workspaces/${workspaceId}/push/test/${testId}`, undefined, headers)
        ).status,
      }
    } finally {
      findLive.mockRestore()
      findTestProgress.mockRestore()
      await shipper.flush()
      await shipper.shutdown()
      logger.level = levelBefore
    }
    const captured = exceptions.mock.calls.map(([error, context]) => [String(error), context])
    exceptions.mockRestore()

    const records = lines
      .flatMap((line) => line.split("\n"))
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      // The upper-cased receipt path sanitizes to all-:id segments, so it is matched by that shape.
      .filter(
        (r) =>
          (typeof r.msg === "string" && / \/(?:[^ ]*push[^ ]*|(?::id\/){4}:id) \d{3}$/i.test(r.msg)) ||
          r.msg === "Unhandled error"
      )
      .map(({ time: _t, pid: _p, hostname: _h, responseTime: _r, ...rest }) => rest)
    const receiptTemplate = "/api/workspaces/:id/push/receipts"
    const progressTemplate = "/api/workspaces/:id/push/test/:id"
    const requestLog = (level: number, method: string, path: string, statusCode: number) => ({
      level,
      req: { method, url: path },
      res: { statusCode },
      msg: `${method} ${path} ${statusCode}`,
    })
    const unhandled = (method: string, path: string) => ({
      level: 50,
      path,
      method,
      errorCode: "57P01",
      msg: "Unhandled error",
    })
    const shippedText = shipped.join("\n")

    expect({
      statuses,
      records,
      captured,
      shippedAnonymousRecords: [receiptTemplate, progressTemplate, "Unhandled error"].map((s) =>
        shippedText.includes(s)
      ),
    }).toEqual({
      statuses: { malformed: 400, overlarge: 413, ingestFailure: 500, progressFailure: 500 },
      records: [
        requestLog(40, "POST", receiptTemplate, 400),
        requestLog(30, "POST", "/:id/:id/:id/:id/:id", 413),
        unhandled("POST", receiptTemplate),
        requestLog(50, "POST", receiptTemplate, 500),
        unhandled("GET", progressTemplate),
        requestLog(50, "GET", progressTemplate, 500),
      ],
      captured: [
        [
          "Error: Unhandled error (57P01)",
          { properties: { path: receiptTemplate, method: "POST", status_code: 500, error_code: "57P01" } },
        ],
        [
          "Error: Unhandled error (57P01)",
          { properties: { path: progressTemplate, method: "GET", status_code: 500, error_code: "57P01" } },
        ],
      ],
      shippedAnonymousRecords: [true, true, true],
    })
    const everything = [lines.join("\n"), shippedText, JSON.stringify(captured)].join("\n")
    const leaked = [
      ...Object.values(secrets),
      token,
      hashOf(token),
      workspaceId,
      ownerUserId,
      testId,
      "connection lost",
    ]
    expect(leaked.filter((secret) => everything.includes(secret))).toEqual([])
  })

  test("should log a failed audit insert on a push diagnostic by operation and error code only", async () => {
    const stranger = new TestClient()
    const strangerUser = await loginAs(stranger, `receipt-stranger-${testRunId}@test.com`, "Receipt Stranger")
    const testId = pushDeliveryId()
    const secrets = { requestId: `req-${ownerUserId}`, detail: `Key (actor_id)=(${ownerUserId}) conflicts` }
    const headers = { "X-Request-Id": secrets.requestId }
    const failure = Object.assign(new Error(`audit row for ${workspaceId} rejected`), {
      code: "23505",
      detail: secrets.detail,
    })

    const lines: string[] = []
    addLogDestination({ level: "debug", stream: { write: (line: string) => void lines.push(line) } })
    const shipped: string[] = []
    const levelBefore = logger.level
    const shipper = attachPostHogLogShipping({
      config: { projectToken: "phc_test", host: "https://posthog.example.com", logsLevel: "debug" },
      service: "backend",
      region: null,
      environment: "test",
      flushIntervalMs: 50,
      fetchImpl: (async (_url: string, init: RequestInit) => {
        shipped.push(String(init.body))
        return new Response(null, { status: 200 })
      }) as unknown as typeof fetch,
    })!
    const insert = spyOn(AccessLogRepository, "insert").mockRejectedValue(failure)
    const auditFailures = () =>
      lines
        .flatMap((line) => line.split("\n"))
        .filter((line) => line.includes("access-log insert failed"))
        .map((line) => {
          const { time: _t, pid: _p, hostname: _h, ...rest } = JSON.parse(line) as Record<string, unknown>
          return rest
        })
    let statuses: Record<string, number>
    try {
      const progressPath = `/api/workspaces/${workspaceId}/push/test/${testId}`
      statuses = {
        owner: (await owner.request("GET", progressPath, undefined, headers)).status,
        stranger: (await stranger.request("GET", progressPath, undefined, headers)).status,
      }
      // The insert is fire-and-forget after the response; wait for both failures to be logged.
      for (let i = 0; i < 100 && auditFailures().length < 2; i++) await new Promise((r) => setTimeout(r, 20))
    } finally {
      insert.mockRestore()
      await shipper.flush()
      await shipper.shutdown()
      logger.level = levelBefore
    }
    const shippedText = shipped.join("\n")
    const failed = (operation: string) => ({
      level: 50,
      errorCode: "23505",
      operation,
      msg: "access-log insert failed",
    })

    expect({
      statuses,
      records: auditFailures().sort((a, b) => String(a.operation).localeCompare(String(b.operation))),
      shipped: shippedText.includes("access-log insert failed") && shippedText.includes("push.test_progress"),
    }).toEqual({
      statuses: { owner: 404, stranger: 403 },
      records: [failed("auth.boundary_denied"), failed("push.test_progress")],
      shipped: true,
    })
    const everything = [lines.join("\n"), shippedText].join("\n")
    const leaked = [...Object.values(secrets), workspaceId, ownerUserId, strangerUser.id, testId, "rejected"]
    expect(leaked.filter((secret) => everything.includes(secret))).toEqual([])
  })
})
