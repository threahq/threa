import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, spyOn } from "bun:test"
import type { Pool } from "pg"
import webpush from "web-push"
import { createHash, randomBytes } from "node:crypto"
import {
  ActivityTypes,
  AuthorTypes,
  PrefNotificationLevels,
  SavedStatuses,
  StreamTypes,
  Visibilities,
  DEFAULT_PUSH_ACTIONS,
  DEFAULT_PUSH_REMINDER_MINUTES,
  DEFAULT_PUSH_QUICK_REACTION,
  E2E_PLACEHOLDER_CONTENT_MARKDOWN,
  ENCRYPTED_MESSAGE_PREVIEW_LABEL,
  ANALYTICS_CONSENT_GRANTED,
  ANALYTICS_CONSENT_KEY,
  type PrefNotificationLevel,
  type Visibility,
} from "@threahq/types"
import { DisabledAnalyticsReporter } from "@threahq/backend-common"
import {
  PushClaimLostError,
  PushDeliveryRepository,
  PushReceiptRepository,
  PushService,
  PushSubscriptionRepository,
  PushTelemetry,
  UserSessionRepository,
  createPushDeliverOnDLQ,
  createPushDeliverWorker,
  createPushSessionCleanup,
  type PushSourceEvent,
} from "../../src/features/push"
import { ActivityRepository, ActivityService, type ActivityPushResolution } from "../../src/features/activity"
import { SavedMessagesService, type FiredReminderSource } from "../../src/features/saved-messages"
import { StreamMemberRepository, StreamRepository } from "../../src/features/streams"
import { EventService } from "../../src/features/messaging"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { E2eStreamsRepository } from "../../src/features/e2e-streams"
import { UserPreferencesRepository, UserPreferencesService } from "../../src/features/user-preferences"
import { QueueRepository } from "../../src/lib/queue"
import type { ActivityCreatedOutboxPayload, SavedReminderFiredOutboxPayload } from "../../src/lib/outbox"
import { activityId, messageId, streamId, userId, workspaceId } from "../../src/lib/id"
import { setupIsolatedTestDatabase, addTestMember, testMessageContent } from "./setup"
import {
  claimPushJob,
  drainDuePushJobs,
  listPushJobs,
  makeDeliveryDue,
  runPushDeliverUnder,
  runPushJob,
} from "./push-queue-helpers"

const HOUR_MS = 60 * 60 * 1000
const SECOND_MS = 1000

type Send = () => Promise<unknown>
const accepted: Send = () => Promise.resolve({ statusCode: 201, body: "", headers: {} })
const failing =
  (statusCode: number, headers: Record<string, string> = {}): Send =>
  () =>
    Promise.reject(Object.assign(new Error("Received unexpected response code"), { statusCode, headers, body: "" }))

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition never held")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function registrationKeys(): { p256dh: string; auth: string } {
  return { p256dh: webpush.generateVAPIDKeys().publicKey, auth: randomBytes(16).toString("base64url") }
}

interface DeliveryRow {
  id: string
  subscriptionId: string
  status: string
  attempts: number
  terminalReason: string | null
  nextAttemptAt: Date | null
}

describe("durable push delivery", () => {
  let pool: Pool
  let cleanupDatabase: () => Promise<void>
  let sendSpy: ReturnType<typeof spyOn>
  /** Scripted push-service answers per endpoint; an endpoint without a script accepts. */
  const scripts = new Map<string, Send[]>()
  let nextEventId = BigInt(Date.now()) * 1000n

  beforeAll(async () => {
    // Own database: receipt retention and the lock-wait probe are global, not workspace-scoped.
    const isolated = await setupIsolatedTestDatabase("push_deliver_worker")
    pool = isolated.pool
    cleanupDatabase = isolated.cleanup
    sendSpy = spyOn(webpush, "sendNotification")
  })

  afterAll(async () => {
    sendSpy.mockRestore()
    await cleanupDatabase()
  })

  beforeEach(() => {
    scripts.clear()
    sendSpy.mockReset()
    sendSpy.mockImplementation(((sub: { endpoint: string }) =>
      (scripts.get(sub.endpoint)?.shift() ?? accepted)()) as never)
  })

  function sendsTo(endpoint: string): Array<{
    data: Record<string, unknown>
    receipt: { token: string } | undefined
    options: Record<string, unknown>
  }> {
    return sendSpy.mock.calls
      .filter((call) => (call[0] as { endpoint: string }).endpoint === endpoint)
      .map((call) => {
        const payload = JSON.parse(call[1] as string)
        return { data: payload.data, receipt: payload.receipt, options: call[2] as Record<string, unknown> }
      })
  }

  function event(createdAt = new Date()): PushSourceEvent {
    return { id: nextEventId++, createdAt }
  }

  async function subscribe(ws: string, uid: string, endpoint: string, receiptVersion?: number) {
    return PushSubscriptionRepository.insert(pool, {
      workspaceId: ws,
      userId: uid,
      endpoint,
      ...registrationKeys(),
      deviceKey: `device-${endpoint}`,
      receiptVersion,
    })
  }

  async function deliveries(ws: string): Promise<DeliveryRow[]> {
    const result = await pool.query(
      `SELECT id, subscription_id, status, attempts, terminal_reason, next_attempt_at
       FROM push_deliveries WHERE workspace_id = $1 ORDER BY id`,
      [ws]
    )
    return result.rows.map((r) => ({
      id: r.id,
      subscriptionId: r.subscription_id,
      status: r.status,
      attempts: r.attempts,
      terminalReason: r.terminal_reason,
      nextAttemptAt: r.next_attempt_at,
    }))
  }

  async function deliveryFor(ws: string, subscriptionId: string): Promise<DeliveryRow> {
    return (await deliveries(ws)).find((d) => d.subscriptionId === subscriptionId)!
  }

  async function planCount(ws: string): Promise<number> {
    const result = await pool.query(`SELECT COUNT(*)::int AS n FROM push_delivery_plans WHERE workspace_id = $1`, [ws])
    return result.rows[0].n
  }

  /** Seconds from now, rounded, for asserting scheduled times without clock flakiness. */
  function secondsFromNow(at: Date | null): number | null {
    return at === null ? null : Math.round((at.getTime() - Date.now()) / SECOND_MS)
  }

  describe("with controllable sources", () => {
    interface Sources {
      level: PrefNotificationLevel
      paused: boolean
      /** An Error is thrown once, then the source reads valid again, unless `activityKeepsFailing`. */
      activity: ActivityPushResolution | Error
      activityKeepsFailing: boolean
      activityReads: number
      onResolveActivity: (() => Promise<void>) | null
      onReadPreferences: (() => void) | null
      reminder: FiredReminderSource | null
      rewrapOutstanding: boolean
      /** The user's current consent grant (a value generation), null when not granted. */
      consent: string | null | Error
      onConsent: (() => Promise<void>) | null
    }
    let sources: Sources
    let ws: string
    let uid: string

    beforeEach(() => {
      ws = workspaceId()
      uid = userId()
      sources = {
        level: PrefNotificationLevels.ALL,
        paused: false,
        activity: validActivity("hello"),
        activityKeepsFailing: false,
        activityReads: 0,
        onResolveActivity: null,
        onReadPreferences: null,
        reminder: null,
        rewrapOutstanding: true,
        consent: null,
        onConsent: null,
      }
    })

    type ActivitySource = Extract<ActivityPushResolution, { valid: true }>["source"]

    function validActivity(contentMarkdown: string, overrides: Partial<ActivitySource> = {}): ActivityPushResolution {
      return {
        valid: true,
        source: {
          activityId: "act",
          activityType: ActivityTypes.MENTION,
          streamId: "stream_01PLANNED",
          messageId: "msg_1",
          contentMarkdown,
          encrypted: false,
          e2eRooted: false,
          streamName: "#general",
          authorName: "Ada",
          emoji: null,
          mode: null,
          ...overrides,
        },
      }
    }

    function createService({ enabled = true }: { enabled?: boolean } = {}) {
      return new PushService({
        pool,
        telemetry: new PushTelemetry({ reporter: new DisabledAnalyticsReporter() }),
        vapidConfig: enabled
          ? {
              publicKey: "BM1RQ2UEVpAlbEgYOQ3bDrGAOrJGBmmh4_4UkmtGRzhi-5WPFmPuJbA6zv4kCp0iycvTaH6eveCXedCE0xSnZbk",
              privateKey: "eHUfakWGHrS4ft0HiSGyhTOBCQJ9VAKWl4XK53qsjMg",
              subject: "mailto:test@threa.app",
            }
          : null,
        lookups: {
          getUserPushPreferences: async () => {
            sources.onReadPreferences?.()
            return {
              notificationLevel: sources.level,
              pushActions: [...DEFAULT_PUSH_ACTIONS],
              pushReminderMinutes: DEFAULT_PUSH_REMINDER_MINUTES,
              pushQuickReaction: DEFAULT_PUSH_QUICK_REACTION,
            }
          },
          isNotificationPaused: async () => sources.paused,
          getStreamType: async () => StreamTypes.CHANNEL,
          getWorkosUserId: async () => "user_WORKOS",
          resolveActivityPush: async () => {
            sources.activityReads++
            const hook = sources.onResolveActivity
            sources.onResolveActivity = null
            if (hook) await hook()
            if (sources.activity instanceof Error) {
              const err = sources.activity
              if (!sources.activityKeepsFailing) sources.activity = validActivity("hello")
              throw err
            }
            return sources.activity
          },
          resolveFiredReminder: async () => sources.reminder,
          isRewrapOutstanding: async () => sources.rewrapOutstanding,
          findAnalyticsConsentGrant: async () => {
            await sources.onConsent?.()
            if (sources.consent instanceof Error) throw sources.consent
            return sources.consent
          },
          isE2eRootedStream: async () => false,
        },
      })
    }

    function activityPayload(): ActivityCreatedOutboxPayload {
      return {
        workspaceId: ws,
        targetUserId: uid,
        counts: { mentionCount: 1, activityCount: 1 },
        activity: {
          id: activityId(),
          activityType: ActivityTypes.MENTION,
          streamId: "stream_01PLANNED",
          messageId: messageId(),
          actorId: userId(),
          actorType: "user",
          context: { contentPreview: "stale snapshot" },
          createdAt: new Date().toISOString(),
          isSelf: false,
        },
      }
    }

    function savedReminderPayload(reminderGeneration?: number): SavedReminderFiredOutboxPayload {
      const now = new Date().toISOString()
      return {
        workspaceId: ws,
        targetUserId: uid,
        savedId: "saved_01ABCDEF",
        messageId: null,
        streamId: null,
        saved: {
          id: "saved_01ABCDEF",
          workspaceId: ws,
          userId: uid,
          messageId: null,
          streamId: null,
          conversationId: null,
          status: SavedStatuses.SAVED,
          title: "Standalone reminder",
          note: null,
          remindAt: now,
          reminderSentAt: now,
          savedAt: now,
          statusChangedAt: now,
          message: null,
          unavailableReason: null,
        },
        ...(reminderGeneration === undefined ? {} : { reminderGeneration }),
      }
    }

    /** From the next source read on, the clock runs `ms` ahead, as if the reads took that long. */
    function slowReads(ms: number, on: "activity" | "preferences") {
      const realNow = Date.now.bind(Date)
      const clock = spyOn(Date, "now").mockImplementation(realNow)
      const jump = () => {
        clock.mockImplementation(() => realNow() + ms)
      }
      if (on === "activity") {
        sources.onResolveActivity = async () => jump()
      } else {
        sources.onReadPreferences = () => {
          sources.onReadPreferences = null
          jump()
        }
      }
      return clock
    }

    /** Run every open job, lapsing claims and schedules first, the way queue retries eventually would. */
    async function runUntilQuiet(service: PushService): Promise<void> {
      for (let round = 0; round < 30; round++) {
        const open = (await listPushJobs(pool, ws)).filter((j) => j.completedAt === null && !j.deadLettered)
        if (open.length === 0) return
        for (const job of open) {
          await makeDeliveryDue(pool, job.payload.deliveryId as string)
          await runPushJob(pool, service, job).catch(() => {})
        }
      }
      throw new Error("push jobs never went quiet")
    }

    test("should plan one delivery and one job per device before sending, and plan nothing on a replayed event", async () => {
      const service = createService()
      const a = await subscribe(ws, uid, "https://push.example.com/a")
      const b = await subscribe(ws, uid, "https://push.example.com/b")
      const source = event()
      const payload = activityPayload()

      await service.planActivityPush(source, payload)
      await service.planActivityPush(source, payload)

      const planned = await deliveries(ws)
      expect(sendSpy).not.toHaveBeenCalled()
      expect(await planCount(ws)).toBe(1)
      expect(planned.map((d) => ({ sub: d.subscriptionId, status: d.status, attempts: d.attempts }))).toEqual(
        expect.arrayContaining([
          { sub: a.id, status: "pending", attempts: 0 },
          { sub: b.id, status: "pending", attempts: 0 },
        ])
      )
      expect((await listPushJobs(pool, ws)).map((j) => j.id).sort()).toEqual(planned.map((d) => `${d.id}_a0`).sort())
    })

    test("should send fresh content, never resend an accepted device on job or event replay", async () => {
      const service = createService()
      const a = await subscribe(ws, uid, "https://push.example.com/a")
      const source = event()
      const payload = activityPayload()
      sources.activity = validActivity("current text")

      await service.planActivityPush(source, payload)
      await drainDuePushJobs(pool, service, ws)
      const [firstJob] = await listPushJobs(pool, ws)
      // An operator re-drives the finished job.
      await pool.query(`UPDATE queue_messages SET completed_at = NULL, process_after = NOW() WHERE id = $1`, [
        firstJob!.id,
      ])
      await runPushJob(pool, service, firstJob!)
      await service.planActivityPush(source, payload)
      await drainDuePushJobs(pool, service, ws)

      expect(sendsTo(a.endpoint).map((s) => s.data.contentPreview)).toEqual(["current text"])
      expect((await deliveryFor(ws, a.id)).status).toBe("accepted")
    })

    test("should roll back the plan when enqueueing fails, and plan exactly once when the outbox retries", async () => {
      const service = createService()
      await subscribe(ws, uid, "https://push.example.com/a")
      const source = event()
      const payload = activityPayload()
      const batchInsert = spyOn(QueueRepository, "batchInsert").mockRejectedValueOnce(new Error("connection reset"))
      try {
        await expect(service.planActivityPush(source, payload)).rejects.toThrow("connection reset")
        expect(await planCount(ws)).toBe(0)

        await service.planActivityPush(source, payload)
      } finally {
        batchInsert.mockRestore()
      }

      expect(await planCount(ws)).toBe(1)
      expect(await listPushJobs(pool, ws)).toHaveLength(1)
    })

    test("should settle an accepted device and schedule the unreachable one for a second attempt 30s out", async () => {
      const service = createService()
      const ok = await subscribe(ws, uid, "https://push.example.com/ok")
      const down = await subscribe(ws, uid, "https://push.example.com/down")
      scripts.set(down.endpoint, [failing(503)])

      await service.planActivityPush(event(), activityPayload())
      await drainDuePushJobs(pool, service, ws)

      const okRow = await deliveryFor(ws, ok.id)
      const downRow = await deliveryFor(ws, down.id)
      const retryJob = (await listPushJobs(pool, ws)).find((j) => j.id === `${downRow.id}_a1`)
      expect({
        ok: { status: okRow.status, attempts: okRow.attempts },
        down: { status: downRow.status, attempts: downRow.attempts, retryIn: secondsFromNow(downRow.nextAttemptAt) },
        retryJobAt: retryJob?.processAfter.getTime(),
      }).toEqual({
        ok: { status: "accepted", attempts: 1 },
        down: { status: "pending", attempts: 1, retryIn: 30 },
        retryJobAt: downRow.nextAttemptAt!.getTime(),
      })

      await makeDeliveryDue(pool, downRow.id)
      await drainDuePushJobs(pool, service, ws)

      expect({ ok: sendsTo(ok.endpoint).length, down: sendsTo(down.endpoint).length }).toEqual({ ok: 1, down: 2 })
      expect((await deliveryFor(ws, down.id)).status).toBe("accepted")
    })

    test("should back off 30s, 2m, 8m, 32m and fail after five provider attempts", async () => {
      const service = createService()
      const down = await subscribe(ws, uid, "https://push.example.com/down")
      scripts.set(
        down.endpoint,
        Array.from({ length: 6 }, () => failing(503))
      )

      await service.planActivityPush(event(), activityPayload())
      const waits: Array<number | null> = []
      for (let i = 0; i < 5; i++) {
        await drainDuePushJobs(pool, service, ws)
        const row = await deliveryFor(ws, down.id)
        waits.push(secondsFromNow(row.nextAttemptAt))
        await makeDeliveryDue(pool, row.id)
      }

      const row = await deliveryFor(ws, down.id)
      expect({ waits, sends: sendsTo(down.endpoint).length, status: row.status, attempts: row.attempts }).toEqual({
        waits: [30, 120, 480, 1920, null],
        sends: 5,
        status: "failed",
        attempts: 5,
      })
      expect(row.terminalReason).toBe("max_attempts")
    })

    test("should wait at least the push service's Retry-After seconds", async () => {
      const service = createService()
      const down = await subscribe(ws, uid, "https://push.example.com/throttled")
      scripts.set(down.endpoint, [failing(429, { "retry-after": "600" })])

      await service.planActivityPush(event(), activityPayload())
      await drainDuePushJobs(pool, service, ws)

      const row = await deliveryFor(ws, down.id)
      expect({ status: row.status, retryIn: secondsFromNow(row.nextAttemptAt) }).toEqual({
        status: "pending",
        retryIn: 600,
      })
    })

    test("should expire rather than shorten a Retry-After date past the original event's expiry", async () => {
      const service = createService()
      const down = await subscribe(ws, uid, "https://push.example.com/throttled")
      scripts.set(down.endpoint, [failing(429, { "retry-after": new Date(Date.now() + 2 * HOUR_MS).toUTCString() })])

      await service.planActivityPush(event(new Date(Date.now() - 23 * HOUR_MS)), activityPayload())
      await drainDuePushJobs(pool, service, ws)

      const row = await deliveryFor(ws, down.id)
      expect({ status: row.status, reason: row.terminalReason, attempts: row.attempts }).toEqual({
        status: "expired",
        reason: "retry_window_closed",
        attempts: 1,
      })
      expect((await listPushJobs(pool, ws)).map((j) => j.id)).toEqual([`${row.id}_a0`])
    })

    test("should anchor TTL to the original event: a late event gets the remainder, an expired one plans nothing", async () => {
      const service = createService()
      const sub = await subscribe(ws, uid, "https://push.example.com/late")

      await service.planActivityPush(event(new Date(Date.now() - 25 * HOUR_MS)), activityPayload())
      expect(await planCount(ws)).toBe(0)

      await service.planActivityPush(event(new Date(Date.now() - 23 * HOUR_MS)), activityPayload())
      await drainDuePushJobs(pool, service, ws)

      const ttl = sendsTo(sub.endpoint)[0]!.options.TTL as number
      expect(Math.abs(ttl - 3600)).toBeLessThan(10)
    })

    test("should revalidate before every retry and settle without sending once the push no longer applies", async () => {
      const cases: Record<string, () => Promise<unknown> | void> = {
        read: () => {
          sources.activity = { valid: false, reason: "read" }
        },
        accessLost: () => {
          sources.activity = { valid: false, reason: "access_lost" }
        },
        moved: () => {
          sources.activity = { valid: false, reason: "moved" }
        },
        deleted: () => {
          sources.activity = { valid: false, reason: "gone" }
        },
        paused: () => {
          sources.paused = true
        },
        prefNone: () => {
          sources.level = PrefNotificationLevels.NONE
        },
        mentionsOnly: () => {
          sources.level = PrefNotificationLevels.MENTIONS
          sources.activity = validActivity("hello", { activityType: ActivityTypes.MESSAGE })
        },
        attendedElsewhere: async () => {
          const attended = await subscribe(ws, uid, `https://push.example.com/attended-${ws}`)
          await UserSessionRepository.upsert(pool, {
            workspaceId: ws,
            userId: uid,
            deviceKey: attended.deviceKey,
            focused: true,
            interacted: true,
          })
        },
        lateWake: async () => {
          await pool.query(
            `UPDATE push_delivery_plans SET expires_at = NOW() - INTERVAL '1 second' WHERE workspace_id = $1`,
            [ws]
          )
        },
      }
      const outcomes: Record<string, unknown> = {}
      for (const [name, change] of Object.entries(cases)) {
        ws = workspaceId()
        sources = { ...sources, level: PrefNotificationLevels.ALL, paused: false, activity: validActivity("hello") }
        const service = createService()
        const sub = await subscribe(ws, uid, `https://push.example.com/${name}`)
        scripts.set(sub.endpoint, [failing(503)])
        await service.planActivityPush(event(), activityPayload())
        await drainDuePushJobs(pool, service, ws)
        await change()
        await makeDeliveryDue(pool, (await deliveryFor(ws, sub.id)).id)
        await drainDuePushJobs(pool, service, ws)
        const row = await deliveryFor(ws, sub.id)
        outcomes[name] = { status: row.status, reason: row.terminalReason, sends: sendsTo(sub.endpoint).length }
      }

      const suppressed = (reason: string) => ({ status: "suppressed", reason, sends: 1 })
      expect(outcomes).toEqual({
        read: suppressed("read"),
        accessLost: suppressed("access_lost"),
        moved: suppressed("source_gone"),
        deleted: suppressed("source_gone"),
        paused: suppressed("paused"),
        prefNone: suppressed("pref_none"),
        mentionsOnly: suppressed("mentions_mode"),
        attendedElsewhere: suppressed("not_targeted"),
        lateWake: { status: "expired", reason: "expired", sends: 1 },
      })
    })

    test("should supersede a retry whose registration was re-keyed or deleted, never sending to the new keys", async () => {
      const service = createService()
      const rekeyed = await subscribe(ws, uid, "https://push.example.com/rekeyed")
      const deleted = await subscribe(ws, uid, "https://push.example.com/deleted")
      scripts.set(rekeyed.endpoint, [failing(503)])
      scripts.set(deleted.endpoint, [failing(503)])
      await service.planActivityPush(event(), activityPayload())
      await drainDuePushJobs(pool, service, ws)

      await PushSubscriptionRepository.insert(pool, {
        workspaceId: ws,
        userId: uid,
        endpoint: rekeyed.endpoint,
        ...registrationKeys(),
        deviceKey: rekeyed.deviceKey,
      })
      await PushSubscriptionRepository.deleteByEndpoint(pool, ws, uid, deleted.endpoint)
      for (const row of await deliveries(ws)) await makeDeliveryDue(pool, row.id)
      await drainDuePushJobs(pool, service, ws)

      const rows = await deliveries(ws)
      expect(rows.map((r) => ({ status: r.status, reason: r.terminalReason }))).toEqual([
        { status: "superseded", reason: "superseded" },
        { status: "superseded", reason: "superseded" },
      ])
      expect({ rekeyed: sendsTo(rekeyed.endpoint).length, deleted: sendsTo(deleted.endpoint).length }).toEqual({
        rekeyed: 1,
        deleted: 1,
      })
      expect((await PushSubscriptionRepository.findByUserId(pool, ws, uid)).map((s) => s.id)).toEqual([rekeyed.id])
    })

    test("should retry a failed settle on the same queue job and resend once, at least once", async () => {
      const service = createService()
      const sub = await subscribe(ws, uid, "https://push.example.com/settle-fails")
      await service.planActivityPush(event(), activityPayload())
      const [job] = await listPushJobs(pool, ws)
      const settle = spyOn(PushDeliveryRepository, "settle").mockRejectedValueOnce(new Error("connection terminated"))
      try {
        await expect(runPushJob(pool, service, job!)).rejects.toThrow("connection terminated")
      } finally {
        settle.mockRestore()
      }
      expect((await deliveries(ws))[0]).toMatchObject({ status: "pending", attempts: 0 })

      // The queue's infrastructure retry reruns the same job; no other job exists for the attempt.
      await runPushJob(pool, service, job!)

      expect({
        sends: sendsTo(sub.endpoint).length,
        row: (await deliveries(ws))[0],
        jobs: (await listPushJobs(pool, ws)).map((j) => ({ id: j.id, done: j.completedAt !== null })),
      }).toMatchObject({
        sends: 2,
        row: { status: "accepted", attempts: 1 },
        jobs: [{ id: job!.id, done: true }],
      })
    })

    test("should recover a failed source read before the send and send exactly once", async () => {
      const service = createService()
      const sub = await subscribe(ws, uid, "https://push.example.com/read-fails")
      await service.planActivityPush(event(), activityPayload())
      const [job] = await listPushJobs(pool, ws)
      sources.activity = new Error("statement timeout")

      await expect(runPushJob(pool, service, job!)).rejects.toThrow("statement timeout")
      expect(sendsTo(sub.endpoint)).toHaveLength(0)
      await runPushJob(pool, service, job!)

      expect(sendsTo(sub.endpoint)).toHaveLength(1)
      expect((await deliveries(ws))[0]).toMatchObject({ status: "accepted", attempts: 1 })
    })

    test("should rerun the attempt on the job's next claim after crashes before the send and after acceptance", async () => {
      const service = createService()
      const sub = await subscribe(ws, uid, "https://push.example.com/crashes")
      await service.planActivityPush(event(), activityPayload())
      const [job] = await listPushJobs(pool, ws)
      const deliveryId = (await deliveries(ws))[0]!.id
      /** A process that dies mid-run: nothing releases its claim, so only its lapse lets the job run again. */
      async function crashRun(): Promise<void> {
        const claim = await claimPushJob(pool, job!.id)
        await runPushDeliverUnder(service, job!, claim!).catch(() => {})
        expect(await claimPushJob(pool, job!.id)).toBeNull()
        await makeDeliveryDue(pool, deliveryId)
      }

      sources.activity = new Error("statement timeout")
      await crashRun()
      const sendsAfterEarlyCrash = sendsTo(sub.endpoint).length
      const settle = spyOn(PushDeliveryRepository, "settle").mockRejectedValueOnce(new Error("connection terminated"))
      try {
        await crashRun()
      } finally {
        settle.mockRestore()
      }
      await runPushJob(pool, service, job!)

      expect({
        sendsAfterEarlyCrash,
        sends: sendsTo(sub.endpoint).length,
        row: (await deliveries(ws))[0],
        claims: (await QueueRepository.getById(pool, job!.id))?.claimedCount,
      }).toMatchObject({ sendsAfterEarlyCrash: 0, sends: 2, row: { status: "accepted", attempts: 1 }, claims: 3 })
    })

    test("should never send under a claim taken over during slow source reads; the new owner sends once", async () => {
      const service = createService()
      const sub = await subscribe(ws, uid, "https://push.example.com/slow")
      await service.planActivityPush(event(), activityPayload())
      const [job] = await listPushJobs(pool, ws)
      const stale = await claimPushJob(pool, job!.id)
      sources.onResolveActivity = async () => {
        sources.onResolveActivity = null
        await makeDeliveryDue(pool, (await deliveries(ws))[0]!.id)
        await runPushJob(pool, service, job!)
      }

      await expect(runPushDeliverUnder(service, job!, stale!)).rejects.toThrow(PushClaimLostError)

      expect(sendsTo(sub.endpoint)).toHaveLength(1)
      expect((await deliveries(ws))[0]).toMatchObject({ status: "accepted", attempts: 1 })
    })

    test("should write nothing when a stale response arrives after its successor started", async () => {
      const service = createService()
      const sub = await subscribe(ws, uid, "https://push.example.com/stale-response")
      await service.planActivityPush(event(), activityPayload())
      const [job] = await listPushJobs(pool, ws)
      const stale = await claimPushJob(pool, job!.id)
      let releaseStale!: () => void
      scripts.set(sub.endpoint, [
        () =>
          new Promise((resolve, reject) => {
            releaseStale = () => reject(Object.assign(new Error("gone"), { statusCode: 410, headers: {}, body: "" }))
          }),
        failing(503),
      ])
      const staleRun = runPushDeliverUnder(service, job!, stale!)
      await waitFor(() => sendsTo(sub.endpoint).length === 1)

      // The claim lapses; a new owner runs the attempt and schedules its retry.
      await makeDeliveryDue(pool, (await deliveries(ws))[0]!.id)
      await runPushJob(pool, service, job!)
      releaseStale()
      await expect(staleRun).rejects.toThrow(PushClaimLostError)

      expect({
        row: (await deliveries(ws))[0],
        registrations: (await PushSubscriptionRepository.findByUserId(pool, ws, uid)).map((s) => s.id),
        jobs: (await listPushJobs(pool, ws)).map((j) => j.id),
      }).toMatchObject({
        row: { status: "pending", attempts: 1 },
        registrations: [sub.id],
        jobs: [job!.id, `${(await deliveries(ws))[0]!.id}_a1`],
      })
    })

    test("should let one of two concurrent workers claim an attempt's job, and send once", async () => {
      const service = createService()
      const sub = await subscribe(ws, uid, "https://push.example.com/race")
      await service.planActivityPush(event(), activityPayload())
      const [job] = await listPushJobs(pool, ws)

      const now = new Date()
      const claims = await Promise.all(
        ["worker_left", "worker_right"].map((claimedBy) =>
          QueueRepository.batchClaimMessages(pool, {
            queueName: job!.queueName,
            workspaceId: ws,
            claimedBy,
            claimedAt: now,
            claimedUntil: new Date(now.getTime() + 60_000),
            now,
            limit: 1,
          })
        )
      )
      for (const message of claims.flat()) {
        await runPushDeliverUnder(service, job!, {
          messageId: message.id,
          claimedBy: message.claimedBy!,
          claimedCount: message.claimedCount,
        })
      }

      expect(
        claims.map((messages) => messages.map((message) => message.id)).sort((a, b) => a.length - b.length)
      ).toEqual([[], [job!.id]])
      expect(sendsTo(sub.endpoint)).toHaveLength(1)
    })

    test("should never run an attempt from a job other than its own", async () => {
      const service = createService()
      const sub = await subscribe(ws, uid, "https://push.example.com/foreign-job")
      await service.planActivityPush(event(), activityPayload())
      const [job] = await listPushJobs(pool, ws)
      await QueueRepository.batchInsert(pool, [
        {
          id: `${job!.id}_v1_w1`,
          queueName: job!.queueName,
          workspaceId: ws,
          payload: { ...job!.payload, wake: 1 },
          processAfter: new Date(),
          insertedAt: new Date(),
        },
      ])
      const legacyWake = (await listPushJobs(pool, ws)).find((j) => j.id !== job!.id)!

      await runPushJob(pool, service, legacyWake)

      expect({ sends: sendsTo(sub.endpoint).length, row: (await deliveries(ws))[0] }).toMatchObject({
        sends: 0,
        row: { status: "pending", attempts: 0 },
      })
    })

    test("should send each durable kind with its topic, urgency, remaining TTL and current payload", async () => {
      const service = createService()
      const sub = await subscribe(ws, uid, "https://push.example.com/wire")
      const plans: Record<string, () => Promise<void>> = {
        reaction: () => {
          sources.activity = validActivity("**ship it** :rocket: [@kris](user:usr_1)", {
            activityType: ActivityTypes.REACTION,
            emoji: ":+1:",
            authorAvatarUrl: "/api/workspaces/ws_1/users/usr_2/avatar/1700.64.webp",
          })
          return service.planActivityPush(event(), activityPayload())
        },
        mention: () => {
          sources.activity = validActivity("hi @kris")
          return service.planActivityPush(event(), activityPayload())
        },
        reminder: () => {
          sources.reminder = {
            savedId: "saved_01ABCDEF",
            messageId: "msg_9",
            streamId: "stream_01SAVED",
            conversationId: null,
            title: null,
            streamName: "#ops",
            contentMarkdown: "**remember** this",
            unavailableReason: null,
            e2eRooted: false,
          }
          return service.planSavedReminderPush(event(), savedReminderPayload(3))
        },
        rewrap: () =>
          service.planRewrapNudgePush(event(), { workspaceId: ws, targetUserId: uid, rootStreamId: "stream_01ROOT" }),
      }
      const sent: Record<string, unknown> = {}
      for (const [name, plan] of Object.entries(plans)) {
        sendSpy.mockClear()
        await plan()
        await drainDuePushJobs(pool, service, ws)
        sent[name] = sendsTo(sub.endpoint).map(({ data, options }) => ({
          data,
          // The TTL is what is left of the event's 24h; allow the milliseconds the test itself took.
          options: { ...options, TTL: Math.abs((options.TTL as number) - 86_400) <= 5 ? 86_400 : options.TTL },
        }))
      }

      const options = (topic: string) => ({ timeout: 10_000, TTL: 86_400, urgency: "high", topic })
      const activityData = {
        workspaceId: ws,
        streamId: "stream_01PLANNED",
        messageId: "msg_1",
        streamName: "#general",
        authorName: "Ada",
        workosUserId: "user_WORKOS",
        pushActions: [...DEFAULT_PUSH_ACTIONS],
        pushReminderMinutes: DEFAULT_PUSH_REMINDER_MINUTES,
        pushQuickReaction: DEFAULT_PUSH_QUICK_REACTION,
      }
      expect(sent).toEqual({
        reaction: [
          {
            data: {
              ...activityData,
              activityType: ActivityTypes.REACTION,
              contentPreview: "ship it 🚀 @kris",
              authorAvatarUrl: "/api/workspaces/ws_1/users/usr_2/avatar/1700.64.webp",
              emoji: "👍",
            },
            options: options("01PLANNED"),
          },
        ],
        mention: [
          {
            data: { ...activityData, activityType: ActivityTypes.MENTION, contentPreview: "hi @kris" },
            options: options("01PLANNEDm"),
          },
        ],
        reminder: [
          {
            data: {
              kind: "saved_reminder",
              workspaceId: ws,
              savedId: "saved_01ABCDEF",
              streamId: "stream_01SAVED",
              messageId: "msg_9",
              streamName: "#ops",
              contentPreview: "remember this",
              unavailableReason: null,
            },
            options: options("01ABCDEF"),
          },
        ],
        rewrap: [
          {
            data: { kind: "rewrap_needed", workspaceId: ws, streamId: "stream_01ROOT", workosUserId: "user_WORKOS" },
            options: options("01ROOTr"),
          },
        ],
      })
    })

    test("should expire without sending when slow source reads outlast the send window", async () => {
      const service = createService()
      const sub = await subscribe(ws, uid, "https://push.example.com/slow-past-expiry")
      await service.planActivityPush(event(new Date(Date.now() - 24 * HOUR_MS + 30 * SECOND_MS)), activityPayload())

      const clock = slowReads(60 * SECOND_MS, "activity")
      try {
        await drainDuePushJobs(pool, service, ws)
      } finally {
        clock.mockRestore()
      }

      const row = (await deliveries(ws))[0]!
      expect({ sends: sendsTo(sub.endpoint).length, status: row.status, reason: row.terminalReason }).toEqual({
        sends: 0,
        status: "expired",
        reason: "expired",
      })
    })

    test("should send only the TTL left after slow source reads", async () => {
      const service = createService()
      const sub = await subscribe(ws, uid, "https://push.example.com/slow-ttl")
      await service.planActivityPush(event(new Date(Date.now() - 23 * HOUR_MS)), activityPayload())

      const clock = slowReads(10 * 60 * SECOND_MS, "activity")
      try {
        await drainDuePushJobs(pool, service, ws)
      } finally {
        clock.mockRestore()
      }

      const ttl = sendsTo(sub.endpoint)[0]!.options.TTL as number
      expect(Math.abs(ttl - 3000)).toBeLessThan(10)
    })

    test("should not send a legacy reminder whose expiry passes during its reads", async () => {
      const service = createService()
      const sub = await subscribe(ws, uid, "https://push.example.com/legacy-slow")

      const clock = slowReads(60 * SECOND_MS, "preferences")
      try {
        await service.planSavedReminderPush(
          event(new Date(Date.now() - 24 * HOUR_MS + 30 * SECOND_MS)),
          savedReminderPayload()
        )
      } finally {
        clock.mockRestore()
      }

      expect(sendsTo(sub.endpoint)).toHaveLength(0)
    })

    test("should fail a delivery as infrastructure after three abandoned claims, never sending", async () => {
      const service = createService()
      const sub = await subscribe(ws, uid, "https://push.example.com/poisoned-read")
      await service.planActivityPush(event(), activityPayload())
      sources.activity = new Error("statement timeout")
      sources.activityKeepsFailing = true

      await runUntilQuiet(service)

      const row = (await deliveries(ws))[0]!
      expect({
        sends: sendsTo(sub.endpoint).length,
        reads: sources.activityReads,
        row: { status: row.status, reason: row.terminalReason, attempts: row.attempts },
      }).toEqual({ sends: 0, reads: 3, row: { status: "failed", reason: "infrastructure", attempts: 0 } })
    })

    test("should bound the resends a failing settle causes to the abandoned-claim budget", async () => {
      const service = createService()
      const sub = await subscribe(ws, uid, "https://push.example.com/settle-keeps-failing")
      await service.planActivityPush(event(), activityPayload())
      const realSettle = PushDeliveryRepository.settle.bind(PushDeliveryRepository)
      const settle = spyOn(PushDeliveryRepository, "settle").mockImplementation(async (db, params) => {
        if (params.settlement.kind === "terminal" && params.settlement.attempted) {
          throw new Error("connection terminated")
        }
        return realSettle(db, params)
      })
      try {
        await runUntilQuiet(service)
      } finally {
        settle.mockRestore()
      }

      const row = (await deliveries(ws))[0]!
      expect({ sends: sendsTo(sub.endpoint).length, status: row.status, reason: row.terminalReason }).toEqual({
        sends: 3,
        status: "failed",
        reason: "infrastructure",
      })
    })

    test("should carry abandoned claims into the next attempt's job, so the budget spans the delivery", async () => {
      const service = createService()
      const sub = await subscribe(ws, uid, "https://push.example.com/crashes-across-attempts")
      scripts.set(sub.endpoint, [failing(503)])
      await service.planActivityPush(event(), activityPayload())
      const [first] = await listPushJobs(pool, ws)
      // Two claims of the first attempt's job die before settling; the third settles a retry.
      for (let i = 0; i < 2; i++) {
        sources.activity = new Error("statement timeout")
        await expect(runPushJob(pool, service, first!)).rejects.toThrow("statement timeout")
      }
      await runPushJob(pool, service, first!)
      const row = (await deliveries(ws))[0]!
      const retry = (await listPushJobs(pool, ws)).find((j) => j.id === `${row.id}_a1`)!
      expect(retry.payload).toMatchObject({ attempt: 1, abandonedClaims: 2 })

      // One more abandoned claim on the retry's job exhausts the delivery's budget of three.
      await makeDeliveryDue(pool, row.id)
      sources.activity = new Error("statement timeout")
      await expect(runPushJob(pool, service, retry)).rejects.toThrow("statement timeout")
      await runPushJob(pool, service, retry)

      expect({ sends: sendsTo(sub.endpoint).length, row: (await deliveries(ws))[0] }).toMatchObject({
        sends: 1,
        row: { status: "failed", terminalReason: "infrastructure", attempts: 1 },
      })
    })

    test("should keep a registration that signs back in while its session-expired notice sends, and remove a stale one", async () => {
      const service = createService()
      const reRegistered = await subscribe(ws, uid, "https://push.example.com/re-registered")
      const heartbeat = await subscribe(ws, uid, "https://push.example.com/heartbeat")
      const stale = await subscribe(ws, uid, "https://push.example.com/still-stale")
      await pool.query(
        `UPDATE push_subscriptions SET updated_at = NOW() - INTERVAL '60 days' WHERE workspace_id = $1`,
        [ws]
      )
      scripts.set(reRegistered.endpoint, [
        async () => {
          await PushSubscriptionRepository.insert(pool, {
            workspaceId: ws,
            userId: uid,
            endpoint: reRegistered.endpoint,
            p256dh: reRegistered.p256dh,
            auth: reRegistered.auth,
            deviceKey: reRegistered.deviceKey,
          })
          return accepted()
        },
      ])
      scripts.set(heartbeat.endpoint, [
        async () => {
          await UserSessionRepository.upsert(pool, { workspaceId: ws, userId: uid, deviceKey: heartbeat.deviceKey })
          return accepted()
        },
      ])

      await service.planActivityPush(event(), activityPayload())
      await drainDuePushJobs(pool, service, ws)

      const remaining = await PushSubscriptionRepository.findByUserId(pool, ws, uid)
      expect({
        notices: [reRegistered, heartbeat, stale].map((s) => sendsTo(s.endpoint).length),
        remaining: remaining
          .map((s) => ({ id: s.id, generation: s.generation }))
          .sort((a, b) => a.id.localeCompare(b.id)),
      }).toEqual({
        notices: [1, 1, 1],
        remaining: [reRegistered, heartbeat]
          .map((s) => ({ id: s.id, generation: s.generation }))
          .sort((a, b) => a.id.localeCompare(b.id)),
      })
    })

    test("should re-plan a dead-lettered session-expired notice the next day, never twice the same day", async () => {
      const service = createService()
      const stale = await subscribe(ws, uid, "https://push.example.com/dead-lettered-notice")
      await pool.query(
        `UPDATE push_subscriptions SET updated_at = NOW() - INTERVAL '60 days' WHERE workspace_id = $1`,
        [ws]
      )
      await service.planActivityPush(event(), activityPayload())
      const [first] = await listPushJobs(pool, ws)
      await pool.query(`UPDATE queue_messages SET dlq_at = NOW() WHERE id = $1`, [first!.id])

      await service.planActivityPush(event(), activityPayload())
      const sameDay = (await listPushJobs(pool, ws)).map((j) => j.id)
      const nextDay = Date.now() + 25 * HOUR_MS
      const clock = spyOn(Date, "now").mockImplementation(() => nextDay)
      try {
        await service.planActivityPush(event(new Date(nextDay)), activityPayload())
      } finally {
        clock.mockRestore()
      }
      await drainDuePushJobs(pool, service, ws)

      const jobs = await listPushJobs(pool, ws)
      expect({
        sameDay,
        jobs: jobs.map((j) => ({ deadLettered: j.deadLettered, completed: j.completedAt !== null })),
        notices: sendsTo(stale.endpoint).map((s) => s.data.action),
        remaining: (await PushSubscriptionRepository.findByUserId(pool, ws, uid)).length,
      }).toEqual({
        sameDay: [first!.id],
        jobs: [
          { deadLettered: true, completed: false },
          { deadLettered: false, completed: true },
        ],
        notices: ["session_expired"],
        remaining: 0,
      })
    })

    test("should never plan a push for a saved_reminder activity row", async () => {
      const service = createService()
      await subscribe(ws, uid, "https://push.example.com/reminder-activity")
      const payload = activityPayload()
      payload.activity.activityType = ActivityTypes.SAVED_REMINDER

      await service.planActivityPush(event(), payload)

      expect({ plans: await planCount(ws), jobs: (await listPushJobs(pool, ws)).length }).toEqual({ plans: 0, jobs: 0 })
    })

    test("should stop rewrap attempts at the re-emit window while the TTL keeps the original expiry", async () => {
      const service = createService()
      const sub = await subscribe(ws, uid, "https://push.example.com/rewrap")
      scripts.set(sub.endpoint, [failing(503)])

      await service.planRewrapNudgePush(event(new Date(Date.now() - 9 * 60 * 1000 - 45 * SECOND_MS)), {
        workspaceId: ws,
        targetUserId: uid,
        rootStreamId: "stream_01ROOT",
      })
      await drainDuePushJobs(pool, service, ws)

      const [send] = sendsTo(sub.endpoint)
      expect(Math.abs((send!.options.TTL as number) - (24 * 3600 - 585))).toBeLessThan(10)
      expect(send!.data).toEqual({
        kind: "rewrap_needed",
        workspaceId: ws,
        streamId: "stream_01ROOT",
        workosUserId: "user_WORKOS",
      })
      expect((await deliveries(ws))[0]).toMatchObject({ status: "expired", terminalReason: "retry_window_closed" })
    })

    test("should drop a rewrap retry once the re-wrap is no longer needed", async () => {
      const service = createService()
      const sub = await subscribe(ws, uid, "https://push.example.com/rewrap-resolved")
      scripts.set(sub.endpoint, [failing(503)])
      await service.planRewrapNudgePush(event(), { workspaceId: ws, targetUserId: uid, rootStreamId: "stream_01ROOT" })
      await drainDuePushJobs(pool, service, ws)

      sources.rewrapOutstanding = false
      await makeDeliveryDue(pool, (await deliveries(ws))[0]!.id)
      await drainDuePushJobs(pool, service, ws)

      expect(sendsTo(sub.endpoint)).toHaveLength(1)
      expect((await deliveries(ws))[0]).toMatchObject({ status: "suppressed", terminalReason: "source_gone" })
    })

    test("should send one session-expired notice without retrying, and skip a device that signed back in", async () => {
      const service = createService()
      const stale = await subscribe(ws, uid, "https://push.example.com/stale")
      const back = await subscribe(ws, uid, "https://push.example.com/back")
      await pool.query(
        `UPDATE push_subscriptions SET updated_at = NOW() - INTERVAL '60 days' WHERE workspace_id = $1`,
        [ws]
      )
      scripts.set(stale.endpoint, [failing(503)])

      await service.planActivityPush(event(), activityPayload())
      // Re-registering the same binding refreshes the device without changing its generation.
      await PushSubscriptionRepository.insert(pool, {
        workspaceId: ws,
        userId: uid,
        endpoint: back.endpoint,
        p256dh: back.p256dh,
        auth: back.auth,
        deviceKey: back.deviceKey,
      })
      await drainDuePushJobs(pool, service, ws)

      expect({
        plans: await planCount(ws),
        stale: sendsTo(stale.endpoint),
        back: sendsTo(back.endpoint).length,
        remaining: (await PushSubscriptionRepository.findByUserId(pool, ws, uid)).map((s) => s.id),
        openJobs: (await listPushJobs(pool, ws)).filter((j) => j.completedAt === null).length,
      }).toEqual({
        plans: 0,
        stale: [
          {
            data: { action: "session_expired", workspaceId: ws },
            options: { timeout: 10_000, TTL: 7 * 24 * 3600, urgency: "normal", topic: "session-expired" },
          },
        ],
        back: 0,
        remaining: [back.id],
        openJobs: 0,
      })
    })

    test("should delete ledger rows only once they are a week past expiry, leaving live work alone", async () => {
      const service = createService()
      await subscribe(ws, uid, "https://push.example.com/retention")
      await service.planActivityPush(event(new Date(Date.now() - 9 * 24 * HOUR_MS)), activityPayload())
      expect(await planCount(ws)).toBe(0)
      await pool.query(
        `INSERT INTO push_delivery_plans (id, workspace_id, user_id, kind, source_event_id, source_id, source_created_at, expires_at)
         VALUES ($1, $2, $3, 'activity', $4, 'act_old', NOW() - INTERVAL '9 days', NOW() - INTERVAL '8 days')`,
        [`push_plan_old_${ws}`, ws, uid, (nextEventId++).toString()]
      )
      await pool.query(
        `INSERT INTO push_deliveries (id, workspace_id, plan_id, subscription_id, subscription_generation, status)
         VALUES ($1, $2, $3, 'push_sub_gone', 1, 'accepted')`,
        [`push_del_old_${ws}`, ws, `push_plan_old_${ws}`]
      )
      await service.planActivityPush(event(), activityPayload())

      await service.cleanupExpiredDeliveries()

      expect({ plans: await planCount(ws), deliveries: (await deliveries(ws)).map((d) => d.status) }).toEqual({
        plans: 1,
        deliveries: ["pending"],
      })
    })

    describe("receipt capabilities", () => {
      const hashOf = (token: string) => createHash("sha256").update(token).digest("hex")
      /** A consent grant's value generation, as the preferences table would hand it out. */
      const GRANT = "9001"
      const REGRANT = "9002"
      const tokensSentTo = (endpoint: string) => sendsTo(endpoint).map((s) => s.receipt?.token ?? null)

      async function receiptRow(deliveryId: string) {
        const { rows } = await pool.query(
          `SELECT token_hash, received_at, outcome FROM push_receipts WHERE workspace_id = $1 AND delivery_id = $2`,
          [ws, deliveryId]
        )
        return rows[0] ?? null
      }

      /** "blocked" once the backend `pid` of this suite's own database waits on a lock, within a few seconds. */
      async function waitForBlockedBackend(pid: number): Promise<"blocked" | "never"> {
        for (let i = 0; i < 150; i++) {
          const { rowCount } = await pool.query(
            `SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND datname = current_database() AND wait_event_type = 'Lock'`,
            [pid]
          )
          if ((rowCount ?? 0) > 0) return "blocked"
          await new Promise((resolve) => setTimeout(resolve, 20))
        }
        return "never"
      }

      /** What the ledger says the accepted attempt sent, checked against what the provider stub actually got. */
      async function recordedSend(deliveryId: string, endpoint: string) {
        const { rows } = await pool.query(
          `SELECT sent_topic, sent_with_receipt, sent_claim_version = version - 1 AS by_accepting_claim, sent_at,
                  sent_endpoint_hash
             FROM push_deliveries WHERE id = $1`,
          [deliveryId]
        )
        const [sent] = sendsTo(endpoint)
        return {
          topicMatchesSend: rows[0].sent_topic !== null && rows[0].sent_topic === sent?.options.topic,
          endpointMatchesSend: sent !== undefined && rows[0].sent_endpoint_hash === hashOf(endpoint),
          withReceipt: rows[0].sent_with_receipt,
          byAcceptingClaim: rows[0].by_accepting_claim,
          sentAtRecorded: rows[0].sent_at instanceof Date,
        }
      }

      /** The armed row's stream and its capability and retention windows, measured from the delivery's expiry. */
      async function armedRow(deliveryId: string) {
        const { rows } = await pool.query(
          `SELECT r.stream_id, r.consent_generation::text AS consent_generation,
                  ROUND(EXTRACT(EPOCH FROM r.capability_expires_at - p.expires_at) * 1000)::int AS capability_after_expiry_ms,
                  ROUND(EXTRACT(EPOCH FROM r.retain_until - p.expires_at) * 1000)::int AS retain_after_expiry_ms
             FROM push_receipts r
             JOIN push_deliveries d ON d.workspace_id = r.workspace_id AND d.id = r.delivery_id
             JOIN push_delivery_plans p ON p.workspace_id = d.workspace_id AND p.id = d.plan_id
            WHERE r.workspace_id = $1 AND r.delivery_id = $2`,
          [ws, deliveryId]
        )
        return rows[0] ?? null
      }

      async function ledgerIdentity(deliveryId: string) {
        const { rows } = await pool.query(`SELECT version, attempts, status FROM push_deliveries WHERE id = $1`, [
          deliveryId,
        ])
        return rows[0]
      }

      function reminderSource(e2eRooted: boolean): FiredReminderSource {
        return {
          savedId: "saved_01ABCDEF",
          messageId: "msg_9",
          streamId: "stream_01SAVED",
          conversationId: null,
          title: null,
          streamName: "#ops",
          contentMarkdown: "remember this",
          unavailableReason: null,
          e2eRooted,
        }
      }

      test("should arm a hash-only receipt and send its token only when consent is granted, the root is not end-to-end encrypted and the active worker supports receipts", async () => {
        const service = createService()
        const planActivity = () => service.planActivityPush(event(), activityPayload())
        const planReminder = () => service.planSavedReminderPush(event(), savedReminderPayload(3))
        const cases: Array<{
          name: string
          setup: () => void
          plan?: () => Promise<void>
          receiptVersion?: number
          armedStream: string | null
        }> = [
          {
            name: "consenting",
            setup: () => (sources.consent = GRANT),
            receiptVersion: 1,
            armedStream: "stream_01PLANNED",
          },
          { name: "denied", setup: () => (sources.consent = null), receiptVersion: 1, armedStream: null },
          { name: "unknown worker", setup: () => (sources.consent = GRANT), armedStream: null },
          {
            name: "encrypted",
            setup: () => {
              sources.consent = GRANT
              sources.activity = validActivity("sealed", { encrypted: true, e2eRooted: true })
            },
            receiptVersion: 1,
            armedStream: null,
          },
          {
            name: "plaintext under an end-to-end encrypted root",
            setup: () => {
              sources.consent = GRANT
              sources.activity = validActivity("old plaintext", { encrypted: false, e2eRooted: true })
            },
            receiptVersion: 1,
            armedStream: null,
          },
          {
            name: "reminder under an end-to-end encrypted root",
            setup: () => {
              sources.consent = GRANT
              sources.reminder = reminderSource(true)
            },
            plan: planReminder,
            receiptVersion: 1,
            armedStream: null,
          },
          {
            name: "consenting reminder",
            setup: () => {
              sources.consent = GRANT
              sources.reminder = reminderSource(false)
            },
            plan: planReminder,
            receiptVersion: 1,
            armedStream: "stream_01SAVED",
          },
          {
            name: "consent read fails",
            setup: () => (sources.consent = new Error("statement timeout")),
            receiptVersion: 1,
            armedStream: null,
          },
        ]

        const observed: Record<string, unknown> = {}
        for (const c of cases) {
          ws = workspaceId()
          sources.activity = validActivity("hello")
          c.setup()
          const sub = await subscribe(
            ws,
            uid,
            `https://push.example.com/${encodeURIComponent(c.name)}`,
            c.receiptVersion
          )
          await (c.plan ?? planActivity)()
          await drainDuePushJobs(pool, service, ws)
          const [token] = tokensSentTo(sub.endpoint)
          const delivery = await deliveryFor(ws, sub.id)
          const row = await receiptRow(delivery.id)
          observed[c.name] = {
            sent: sendsTo(sub.endpoint).length,
            status: delivery.status,
            armed: token != null,
            storedHashOnly: token == null ? row === null : row?.token_hash === hashOf(token),
            armedRow: await armedRow(delivery.id),
            recorded: await recordedSend(delivery.id, sub.endpoint),
          }
        }

        expect(observed).toEqual(
          Object.fromEntries(
            cases.map((c) => [
              c.name,
              {
                sent: 1,
                status: "accepted",
                armed: c.armedStream !== null,
                storedHashOnly: true,
                armedRow:
                  c.armedStream === null
                    ? null
                    : {
                        stream_id: c.armedStream,
                        consent_generation: GRANT,
                        capability_after_expiry_ms: 10 * 60 * SECOND_MS,
                        retain_after_expiry_ms: 7 * 24 * HOUR_MS,
                      },
                recorded: {
                  topicMatchesSend: true,
                  endpointMatchesSend: true,
                  withReceipt: c.armedStream !== null,
                  byAcceptingClaim: true,
                  sentAtRecorded: true,
                },
              },
            ])
          )
        )
      })

      test("should send without a capability when arming the receipt fails", async () => {
        const service = createService()
        sources.consent = GRANT
        const sub = await subscribe(ws, uid, "https://push.example.com/arm-fails", 1)
        const arm = spyOn(PushReceiptRepository, "armDelivery").mockRejectedValue(new Error("connection reset"))
        try {
          await service.planActivityPush(event(), activityPayload())
          await drainDuePushJobs(pool, service, ws)
        } finally {
          arm.mockRestore()
        }

        const delivery = await deliveryFor(ws, sub.id)
        expect({
          tokens: tokensSentTo(sub.endpoint),
          status: delivery.status,
          recorded: await recordedSend(delivery.id, sub.endpoint),
        }).toEqual({
          tokens: [null],
          status: "accepted",
          recorded: {
            topicMatchesSend: true,
            endpointMatchesSend: true,
            withReceipt: false,
            byAcceptingClaim: true,
            sentAtRecorded: true,
          },
        })
      })

      test("should record a receipt without touching the delivery's version or attempts", async () => {
        const service = createService()
        sources.consent = GRANT
        const sub = await subscribe(ws, uid, "https://push.example.com/version", 1)
        await service.planActivityPush(event(), activityPayload())
        await drainDuePushJobs(pool, service, ws)
        const delivery = await deliveryFor(ws, sub.id)
        const before = await ledgerIdentity(delivery.id)
        const [token] = tokensSentTo(sub.endpoint)

        await service.recordReceipt({ workspaceId: ws, token: token!, stage: "received", reason: null })
        await service.recordReceipt({ workspaceId: ws, token: token!, stage: "notification_created", reason: null })

        expect({ ledger: await ledgerIdentity(delivery.id), receipt: await receiptRow(delivery.id) }).toEqual({
          ledger: before,
          receipt: { token_hash: hashOf(token!), received_at: expect.any(Date), outcome: "notification_created" },
        })
      })

      test("should rotate the capability on a retry so only the latest attempt's token records", async () => {
        const service = createService()
        sources.consent = GRANT
        const sub = await subscribe(ws, uid, "https://push.example.com/rotate", 1)
        scripts.set(sub.endpoint, [failing(503)])
        await service.planActivityPush(event(), activityPayload())
        await drainDuePushJobs(pool, service, ws)
        const delivery = await deliveryFor(ws, sub.id)
        await makeDeliveryDue(pool, delivery.id)
        await drainDuePushJobs(pool, service, ws)
        const [first, second] = tokensSentTo(sub.endpoint)

        await service.recordReceipt({ workspaceId: ws, token: first!, stage: "received", reason: null })
        const afterStale = await receiptRow(delivery.id)
        await service.recordReceipt({ workspaceId: ws, token: second!, stage: "received", reason: null })

        expect({
          distinct: first !== second,
          afterStale,
          afterLatest: await receiptRow(delivery.id),
        }).toEqual({
          distinct: true,
          afterStale: { token_hash: hashOf(second!), received_at: null, outcome: null },
          afterLatest: { token_hash: hashOf(second!), received_at: expect.any(Date), outcome: null },
        })
      })

      test("should rotate the capability after an ambiguous attempt the device reported, keeping its facts and never downgrading them", async () => {
        const service = createService()
        sources.consent = GRANT
        const sub = await subscribe(ws, uid, "https://push.example.com/reported-then-retry", 1)
        scripts.set(sub.endpoint, [failing(503)])
        await service.planActivityPush(event(), activityPayload())
        await drainDuePushJobs(pool, service, ws)
        const delivery = await deliveryFor(ws, sub.id)
        const [first] = tokensSentTo(sub.endpoint)
        const beforeReports = await ledgerIdentity(delivery.id)
        await service.recordReceipt({ workspaceId: ws, token: first!, stage: "received", reason: null })
        await service.recordReceipt({ workspaceId: ws, token: first!, stage: "notification_created", reason: null })
        const afterReports = await ledgerIdentity(delivery.id)
        const { rows: reported } = await pool.query(
          `SELECT received_at FROM push_receipts WHERE workspace_id = $1 AND delivery_id = $2`,
          [ws, delivery.id]
        )

        await makeDeliveryDue(pool, delivery.id)
        await drainDuePushJobs(pool, service, ws)
        const [, second] = tokensSentTo(sub.endpoint)
        await service.recordReceipt({ workspaceId: ws, token: second!, stage: "received", reason: null })
        await service.recordReceipt({ workspaceId: ws, token: second!, stage: "suppressed", reason: "focused" })
        const { rows: final } = await pool.query(
          `SELECT token_hash, received_at, outcome, outcome_reason FROM push_receipts WHERE workspace_id = $1 AND delivery_id = $2`,
          [ws, delivery.id]
        )

        const { rows: sent } = await pool.query(`SELECT sent_with_receipt FROM push_deliveries WHERE id = $1`, [
          delivery.id,
        ])

        expect({
          reportsLeftLedger: afterReports,
          retried: second !== undefined && second !== first,
          receipt: final[0],
          firstReceivedKept: final[0].received_at.getTime() === reported[0].received_at.getTime(),
          recorded: { withReceipt: sent[0].sent_with_receipt, status: (await deliveryFor(ws, sub.id)).status },
        }).toEqual({
          reportsLeftLedger: beforeReports,
          retried: true,
          receipt: {
            token_hash: hashOf(second!),
            received_at: expect.any(Date),
            outcome: "notification_created",
            outcome_reason: null,
          },
          firstReceivedKept: true,
          recorded: { withReceipt: true, status: "accepted" },
        })
      })

      test("should refuse to re-arm under a different consent grant and revoke the old grant's token and facts", async () => {
        const service = createService()
        const observed: Record<string, unknown> = {}
        for (const [name, retryGrant] of [
          ["withdrawn", null],
          ["withdrawn and given again", REGRANT],
        ] as const) {
          ws = workspaceId()
          sources.consent = GRANT
          const sub = await subscribe(ws, uid, `https://push.example.com/lineage-${encodeURIComponent(name)}`, 1)
          scripts.set(sub.endpoint, [failing(503)])
          await service.planActivityPush(event(), activityPayload())
          await drainDuePushJobs(pool, service, ws)
          const delivery = await deliveryFor(ws, sub.id)
          const [first] = tokensSentTo(sub.endpoint)
          await service.recordReceipt({ workspaceId: ws, token: first!, stage: "received", reason: null })

          sources.consent = retryGrant
          await makeDeliveryDue(pool, delivery.id)
          await drainDuePushJobs(pool, service, ws)
          await service.recordReceipt({ workspaceId: ws, token: first!, stage: "notification_created", reason: null })
          const { rows } = await pool.query(
            `SELECT token_hash, consent_generation::text AS consent_generation, received_at IS NOT NULL AS received,
                    outcome, revoked_at IS NOT NULL AS revoked
               FROM push_receipts WHERE workspace_id = $1 AND delivery_id = $2`,
            [ws, delivery.id]
          )
          observed[name] = {
            tokens: tokensSentTo(sub.endpoint).map((t) => t !== null),
            receipt: rows[0],
            withReceipt: (
              await pool.query(`SELECT sent_with_receipt FROM push_deliveries WHERE id = $1`, [delivery.id])
            ).rows[0].sent_with_receipt,
          }
        }

        const refused = {
          tokens: [true, false],
          // Revocation erases the stage the old grant allowed; the row stays in its old lineage.
          receipt: { token_hash: null, consent_generation: GRANT, received: false, outcome: null, revoked: true },
          withReceipt: false,
        }
        expect(observed).toEqual({ withdrawn: refused, "withdrawn and given again": refused })
      })

      test("should arm and record nothing when the job's claim is taken over during source reads", async () => {
        const service = createService()
        sources.consent = GRANT
        const sub = await subscribe(ws, uid, "https://push.example.com/lost-claim-arm", 1)
        await service.planActivityPush(event(), activityPayload())
        const [job] = await listPushJobs(pool, ws)
        const stale = await claimPushJob(pool, job!.id)
        let rival: Awaited<ReturnType<typeof claimPushJob>> = null
        sources.onResolveActivity = async () => {
          await makeDeliveryDue(pool, (await deliveries(ws))[0]!.id)
          rival = await claimPushJob(pool, job!.id)
        }

        await expect(runPushDeliverUnder(service, job!, stale!)).rejects.toThrow(PushClaimLostError)
        const delivery = await deliveryFor(ws, sub.id)
        const { rows: sent } = await pool.query(
          `SELECT sent_at, sent_with_receipt FROM push_deliveries WHERE id = $1`,
          [delivery.id]
        )

        expect({
          rivalClaimed: rival !== null,
          sends: sendsTo(sub.endpoint).length,
          receipt: await receiptRow(delivery.id),
          status: delivery.status,
          sent: sent[0],
        }).toEqual({
          rivalClaimed: true,
          sends: 0,
          receipt: null,
          status: "pending",
          sent: { sent_at: null, sent_with_receipt: null },
        })
      })

      test("should hold the job's queue row while arming, so a competing claim waits until the send is recorded", async () => {
        const service = createService()
        sources.consent = GRANT
        const sub = await subscribe(ws, uid, "https://push.example.com/arm-under-claim", 1)
        const armDelivery = PushReceiptRepository.armDelivery.bind(PushReceiptRepository)
        let competingClaim: string | null = null
        const arm = spyOn(PushReceiptRepository, "armDelivery").mockImplementation(async (db, params) => {
          const rival = await pool.connect()
          try {
            await rival.query("BEGIN")
            await rival.query("SET LOCAL lock_timeout = '300ms'")
            await rival.query("UPDATE queue_messages SET claimed_by = 'worker_rival' WHERE id = $1", [
              `${params.deliveryId}_a0`,
            ])
            await rival.query("COMMIT")
            competingClaim = "claimed"
          } catch (err) {
            await rival.query("ROLLBACK")
            competingClaim = (err as { code?: string }).code === "55P03" ? "blocked" : String(err)
          } finally {
            rival.release()
          }
          return armDelivery(db, params)
        })
        try {
          await service.planActivityPush(event(), activityPayload())
          await drainDuePushJobs(pool, service, ws)
        } finally {
          arm.mockRestore()
        }
        const delivery = await deliveryFor(ws, sub.id)
        const [token] = tokensSentTo(sub.endpoint)

        expect({
          competingClaim,
          sends: sendsTo(sub.endpoint).length,
          status: delivery.status,
          stored: (await receiptRow(delivery.id))?.token_hash === hashOf(token!),
        }).toEqual({ competingClaim: "blocked", sends: 1, status: "accepted", stored: true })
      })

      test("should roll back the arming and never send when the claim lapses during a slow arm", async () => {
        const service = createService()
        sources.consent = GRANT
        const sub = await subscribe(ws, uid, "https://push.example.com/slow-arm", 1)
        await service.planActivityPush(event(), activityPayload())
        const [job] = await listPushJobs(pool, ws)
        const armDelivery = PushReceiptRepository.armDelivery.bind(PushReceiptRepository)
        const arm = spyOn(PushReceiptRepository, "armDelivery").mockImplementation(async (db, params) => {
          await new Promise((resolve) => setTimeout(resolve, 400))
          return armDelivery(db, params)
        })
        const shortClaim = await claimPushJob(pool, job!.id, 200)
        let lapsedRun: unknown = null
        try {
          await runPushDeliverUnder(service, job!, shortClaim!).catch((err) => (lapsedRun = err))
        } finally {
          arm.mockRestore()
        }
        const delivery = await deliveryFor(ws, sub.id)
        const afterLapse = { sends: sendsTo(sub.endpoint).length, receipt: await receiptRow(delivery.id) }

        await runPushJob(pool, service, job!)

        expect({
          lapsedRun: lapsedRun instanceof PushClaimLostError,
          afterLapse,
          sends: sendsTo(sub.endpoint).length,
          status: (await deliveryFor(ws, sub.id)).status,
        }).toEqual({ lapsedRun: true, afterLapse: { sends: 0, receipt: null }, sends: 1, status: "accepted" })
      })

      test("should extend the queue claim through the send without a heartbeat shortening it", async () => {
        const service = createService()
        const sub = await subscribe(ws, uid, "https://push.example.com/near-lapse", 1)
        await service.planActivityPush(event(), activityPayload())
        const [job] = await listPushJobs(pool, ws)
        const nearLapse = await claimPushJob(pool, job!.id, 10_000)
        let rivalJobs: string[] | null = null
        scripts.set(sub.endpoint, [
          async () => {
            const now = new Date()
            await QueueRepository.batchRenewClaims(pool, {
              messageIds: [job!.id],
              claimedBy: nearLapse!.claimedBy,
              claimedUntil: new Date(now.getTime() + 10_000),
            })
            rivalJobs = (
              await QueueRepository.batchClaimMessages(pool, {
                queueName: job!.queueName,
                workspaceId: ws,
                claimedBy: "worker_rival",
                claimedAt: new Date(now.getTime() + 20_000),
                claimedUntil: new Date(now.getTime() + 30_000),
                now: new Date(now.getTime() + 20_000),
                limit: 1,
              })
            ).map((message) => message.id)
            return accepted()
          },
        ])

        await runPushDeliverUnder(service, job!, nearLapse!)
        expect({
          rivalJobs,
          sends: sendsTo(sub.endpoint).length,
          status: (await deliveryFor(ws, sub.id)).status,
        }).toEqual({
          rivalJobs: [],
          sends: 1,
          status: "accepted",
        })
      })

      test("should refuse a send when the claim expires after the arming transaction commits", async () => {
        const service = createService()
        sources.consent = GRANT
        const sub = await subscribe(ws, uid, "https://push.example.com/post-commit-lapse", 1)
        await service.planActivityPush(event(), activityPayload())
        const [job] = await listPushJobs(pool, ws)
        const claim = await claimPushJob(pool, job!.id, 10_000)
        const realNow = Date.now.bind(Date)
        let elapsed = 0
        const clock = spyOn(Date, "now").mockImplementation(() => realNow() + elapsed)
        const issued = spyOn(PushTelemetry.prototype, "recordReceipt").mockImplementation((result) => {
          if (result === "issued") elapsed = 61_000
        })
        try {
          await expect(runPushDeliverUnder(service, job!, claim!)).rejects.toThrow(PushClaimLostError)
        } finally {
          issued.mockRestore()
          clock.mockRestore()
        }
        const delivery = await deliveryFor(ws, sub.id)
        expect({
          committedReceipt: (await receiptRow(delivery.id)) !== null,
          sends: sendsTo(sub.endpoint).length,
          status: delivery.status,
        }).toEqual({
          committedReceipt: true,
          sends: 0,
          status: "pending",
        })
      })

      test("should serialize a report with a concurrent re-arm: the re-arm waits, then rotates the token and keeps the reported stage", async () => {
        const service = createService()
        sources.consent = GRANT
        const sub = await subscribe(ws, uid, "https://push.example.com/report-vs-rearm", 1)
        await service.planActivityPush(event(), activityPayload())
        await drainDuePushJobs(pool, service, ws)
        const delivery = await deliveryFor(ws, sub.id)
        const [token] = tokensSentTo(sub.endpoint)
        const rotated = randomBytes(32).toString("base64url")
        const rearmClient = await pool.connect()
        let rearm: Promise<boolean> | null = null
        let rearmWhileChecking: string | null = null
        try {
          const { rows } = await rearmClient.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
          sources.onConsent = async () => {
            sources.onConsent = null
            rearm = PushReceiptRepository.armDelivery(rearmClient, {
              workspaceId: ws,
              userId: uid,
              deliveryId: delivery.id,
              subscriptionId: sub.id,
              streamId: "stream_01PLANNED",
              tokenHash: hashOf(rotated),
              consentGeneration: GRANT,
              capabilityExpiresAt: new Date(Date.now() + HOUR_MS),
              retainUntil: new Date(Date.now() + HOUR_MS),
            })
            rearmWhileChecking = await Promise.race([
              rearm.then(() => "landed" as const),
              waitForBlockedBackend(rows[0]!.pid),
            ])
          }

          await service.recordReceipt({ workspaceId: ws, token: token!, stage: "received", reason: null })
          await rearm
        } finally {
          rearmClient.release()
        }

        expect({ rearmWhileChecking, rearmed: await rearm!, receipt: await receiptRow(delivery.id) }).toEqual({
          rearmWhileChecking: "blocked",
          rearmed: true,
          receipt: { token_hash: hashOf(rotated), received_at: expect.any(Date), outcome: null },
        })
      })

      test("should lock the receipt before reading consent when a retry re-arms, in the order receipt ingest takes them", async () => {
        const service = createService()
        sources.consent = GRANT
        const sub = await subscribe(ws, uid, "https://push.example.com/rearm-lock-order", 1)
        scripts.set(sub.endpoint, [failing(503)])
        await service.planActivityPush(event(), activityPayload())
        await drainDuePushJobs(pool, service, ws)
        const delivery = await deliveryFor(ws, sub.id)
        await makeDeliveryDue(pool, delivery.id)

        const holder = await pool.connect()
        let consentReached = false
        sources.onConsent = async () => {
          consentReached = true
        }
        let retry: Promise<void> | null = null
        let whileHeld: { waiter: "blocked" | "never" | "finished"; consentReached: boolean } | null = null
        try {
          const { rows: holderRows } = await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
          await holder.query("BEGIN")
          const { rowCount: held } = await holder.query(
            "SELECT 1 FROM push_receipts WHERE workspace_id = $1 AND delivery_id = $2 FOR UPDATE",
            [ws, delivery.id]
          )
          expect(held).toBe(1)

          retry = drainDuePushJobs(pool, service, ws)
          const waitForWaiter = async (): Promise<"blocked" | "never"> => {
            for (let i = 0; i < 150; i++) {
              const { rowCount } = await pool.query(
                `SELECT 1 FROM pg_stat_activity
                  WHERE datname = current_database() AND $1 = ANY(pg_blocking_pids(pid))`,
                [holderRows[0]!.pid]
              )
              if ((rowCount ?? 0) > 0) return "blocked"
              await new Promise((resolve) => setTimeout(resolve, 20))
            }
            return "never"
          }
          const waiter = await Promise.race([retry.then(() => "finished" as const), waitForWaiter()])
          whileHeld = { waiter, consentReached }
          await holder.query("COMMIT")
          await retry
        } finally {
          await holder.query("ROLLBACK").catch(() => {})
          holder.release()
          await retry?.catch(() => {})
          sources.onConsent = null
        }
        const [first, second] = tokensSentTo(sub.endpoint)

        expect({
          whileHeld,
          consentReached,
          rotated: first !== second,
          receipt: await receiptRow(delivery.id),
          status: (await deliveryFor(ws, sub.id)).status,
        }).toEqual({
          whileHeld: { waiter: "blocked", consentReached: false },
          consentReached: true,
          rotated: true,
          receipt: { token_hash: hashOf(second!), received_at: null, outcome: null },
          status: "accepted",
        })
      })

      test("should delete receipt rows past retention and keep live ones", async () => {
        const service = createService()
        const arm = (deliveryId: string, retainUntil: Date) =>
          PushReceiptRepository.armDelivery(pool, {
            workspaceId: ws,
            userId: uid,
            deliveryId,
            subscriptionId: "push_sub_retention",
            streamId: null,
            tokenHash: hashOf(randomBytes(32).toString("base64url")),
            consentGeneration: GRANT,
            capabilityExpiresAt: new Date(Date.now() - HOUR_MS),
            retainUntil,
          })
        await arm("push_del_expired", new Date(Date.now() - SECOND_MS))
        await arm("push_del_live", new Date(Date.now() + HOUR_MS))

        await service.cleanupExpiredReceipts()

        const { rows } = await pool.query(`SELECT delivery_id FROM push_receipts WHERE workspace_id = $1`, [ws])
        expect(rows.map((r) => r.delivery_id)).toEqual(["push_del_live"])
      })

      test("should delete expired receipts on the cleanup timer while push sending is disabled", async () => {
        const service = createService({ enabled: false })
        await PushReceiptRepository.armDelivery(pool, {
          workspaceId: ws,
          userId: uid,
          deliveryId: "push_del_disabled_expired",
          subscriptionId: "push_sub_disabled",
          streamId: null,
          tokenHash: hashOf(randomBytes(32).toString("base64url")),
          consentGeneration: GRANT,
          capabilityExpiresAt: new Date(Date.now() - HOUR_MS),
          retainUntil: new Date(Date.now() - SECOND_MS),
        })
        const cleanup = createPushSessionCleanup(service, { intervalMs: 20 })
        cleanup.start()
        let remaining = 1
        try {
          for (let i = 0; i < 100 && remaining > 0; i++) {
            await new Promise((resolve) => setTimeout(resolve, 20))
            remaining = (await pool.query(`SELECT COUNT(*)::int AS n FROM push_receipts WHERE workspace_id = $1`, [ws]))
              .rows[0].n
          }
        } finally {
          cleanup.stop()
        }

        expect({ enabled: service.isEnabled(), remaining }).toEqual({ enabled: false, remaining: 0 })
      })

      test("should reset a device's receipt support to unknown when it re-registers without advertising it", async () => {
        const endpoint = "https://push.example.com/re-register"
        const advertised = await subscribe(ws, uid, endpoint, 1)
        const reregistered = await subscribe(ws, uid, endpoint)

        expect({ advertised: advertised.receiptVersion, reregistered: reregistered.receiptVersion }).toEqual({
          advertised: 1,
          reregistered: null,
        })
      })
    })
  })

  describe("with real sources", () => {
    let activityService: ActivityService
    let savedService: SavedMessagesService
    let eventService: EventService
    let preferencesService: UserPreferencesService

    beforeAll(() => {
      preferencesService = new UserPreferencesService(pool)
      activityService = new ActivityService({ pool })
      savedService = new SavedMessagesService({ pool })
      eventService = new EventService(pool)
    })

    function createService() {
      return new PushService({
        pool,
        telemetry: new PushTelemetry({ reporter: new DisabledAnalyticsReporter() }),
        vapidConfig: {
          publicKey: "BM1RQ2UEVpAlbEgYOQ3bDrGAOrJGBmmh4_4UkmtGRzhi-5WPFmPuJbA6zv4kCp0iycvTaH6eveCXedCE0xSnZbk",
          privateKey: "eHUfakWGHrS4ft0HiSGyhTOBCQJ9VAKWl4XK53qsjMg",
          subject: "mailto:test@threa.app",
        },
        lookups: {
          getUserPushPreferences: async () => ({
            notificationLevel: PrefNotificationLevels.ALL,
            pushActions: [...DEFAULT_PUSH_ACTIONS],
            pushReminderMinutes: DEFAULT_PUSH_REMINDER_MINUTES,
            pushQuickReaction: DEFAULT_PUSH_QUICK_REACTION,
          }),
          isNotificationPaused: async () => false,
          getStreamType: async () => StreamTypes.CHANNEL,
          getWorkosUserId: async () => null,
          resolveActivityPush: (params) => activityService.resolvePushSource(params),
          resolveFiredReminder: (params) => savedService.resolveFiredReminder(params),
          isRewrapOutstanding: async () => false,
          findAnalyticsConsentGrant: (db, userId) => preferencesService.findAnalyticsConsentGrant(db, userId),
          isE2eRootedStream: async (db, workspaceId, streamId) =>
            (await E2eStreamsRepository.excludeE2eRootedStreamIds(db, [{ workspaceId, streamId }])).length === 0,
        },
      })
    }

    async function workspaceWithUsers() {
      const ws = workspaceId()
      const author = await addTestMember(pool, ws, `author_${ws}`)
      const recipient = await addTestMember(pool, ws, `recipient_${ws}`)
      await WorkspaceRepository.insert(pool, { id: ws, name: "Push WS", slug: `push-${ws}`, createdBy: author.id })
      return { ws, author, recipient }
    }

    async function channel(ws: string, createdBy: string, visibility: Visibility) {
      return StreamRepository.insert(pool, {
        id: streamId(),
        workspaceId: ws,
        type: StreamTypes.CHANNEL,
        slug: `c-${streamId().slice(-8)}`,
        visibility,
        createdBy,
      })
    }

    async function threadMention(ws: string, visibility: Visibility, rootMembers: (ids: string[]) => string[]) {
      const users = await workspaceWithUsers()
      const root = await channel(ws === "" ? users.ws : ws, users.author.id, visibility)
      const members = rootMembers([users.author.id, users.recipient.id])
      if (members.length > 0) await StreamMemberRepository.insertMany(pool, root.workspaceId, root.id, members)
      const child = await StreamRepository.insert(pool, {
        id: streamId(),
        workspaceId: users.ws,
        type: StreamTypes.THREAD,
        displayName: "A thread",
        parentStreamId: root.id,
        rootStreamId: root.id,
        createdBy: users.author.id,
      })
      const message = await eventService.createMessage({
        workspaceId: users.ws,
        streamId: child.id,
        authorId: users.author.id,
        authorType: AuthorTypes.USER,
        ...testMessageContent("original text"),
      })
      const row = (await ActivityRepository.insert(pool, {
        workspaceId: users.ws,
        userId: users.recipient.id,
        activityType: ActivityTypes.MENTION,
        streamId: child.id,
        messageId: message.id,
        actorId: users.author.id,
        actorType: AuthorTypes.USER,
        context: { contentPreview: "original text" },
      }))!
      const payload: ActivityCreatedOutboxPayload = {
        workspaceId: users.ws,
        targetUserId: users.recipient.id,
        counts: { mentionCount: 1, activityCount: 1 },
        activity: {
          id: row.id,
          activityType: row.activityType,
          streamId: child.id,
          messageId: message.id,
          actorId: users.author.id,
          actorType: AuthorTypes.USER,
          context: row.context,
          createdAt: row.createdAt.toISOString(),
          isSelf: false,
        },
      }
      return { ...users, root, child, message, payload }
    }

    test("should push a thread mention to a root member who is not a thread member, then stop once they leave the root", async () => {
      const service = createService()
      const ctx = await threadMention("", Visibilities.PRIVATE, (ids) => ids)
      const sub = await subscribe(ctx.ws, ctx.recipient.id, `https://push.example.com/${ctx.ws}`)
      scripts.set(sub.endpoint, [failing(503)])
      await eventService.editMessageInternal({
        workspaceId: ctx.ws,
        messageId: ctx.message.id,
        streamId: ctx.child.id,
        actorId: ctx.author.id,
        ...testMessageContent("edited text"),
      })

      await service.planActivityPush(event(), ctx.payload)
      await drainDuePushJobs(pool, service, ctx.ws)
      await StreamMemberRepository.delete(pool, ctx.ws, ctx.root.id, ctx.recipient.id)
      await makeDeliveryDue(pool, (await deliveries(ctx.ws))[0]!.id)
      await drainDuePushJobs(pool, service, ctx.ws)

      expect(sendsTo(sub.endpoint).map((s) => s.data.contentPreview)).toEqual(["edited text"])
      expect((await deliveries(ctx.ws))[0]).toMatchObject({ status: "suppressed", terminalReason: "access_lost" })
    })

    test("should push a thread mention under a public root without any membership", async () => {
      const service = createService()
      const ctx = await threadMention("", Visibilities.PUBLIC, () => [])
      const sub = await subscribe(ctx.ws, ctx.recipient.id, `https://push.example.com/${ctx.ws}`)

      await service.planActivityPush(event(), ctx.payload)
      await drainDuePushJobs(pool, service, ctx.ws)

      expect(sendsTo(sub.endpoint).map((s) => s.data.contentPreview)).toEqual(["original text"])
      expect((await deliveries(ctx.ws))[0]).toMatchObject({ status: "accepted" })
    })

    test("should drop a retry once the activity was read", async () => {
      const service = createService()
      const ctx = await threadMention("", Visibilities.PUBLIC, () => [])
      const sub = await subscribe(ctx.ws, ctx.recipient.id, `https://push.example.com/${ctx.ws}`)
      scripts.set(sub.endpoint, [failing(503)])

      await service.planActivityPush(event(), ctx.payload)
      await drainDuePushJobs(pool, service, ctx.ws)
      await pool.query(`UPDATE user_activity SET read_at = NOW() WHERE id = $1`, [ctx.payload.activity.id])
      await makeDeliveryDue(pool, (await deliveries(ctx.ws))[0]!.id)
      await drainDuePushJobs(pool, service, ctx.ws)

      expect(sendsTo(sub.endpoint)).toHaveLength(1)
      expect((await deliveries(ctx.ws))[0]).toMatchObject({ status: "suppressed", terminalReason: "read" })
    })

    describe("saved reminder", () => {
      async function firedReminder(text = "remember this", e2e = false, inThread = false) {
        const users = await workspaceWithUsers()
        const root = await channel(users.ws, users.author.id, Visibilities.PUBLIC)
        const posted = inThread
          ? await StreamRepository.insert(pool, {
              id: streamId(),
              workspaceId: users.ws,
              type: StreamTypes.THREAD,
              displayName: "A thread",
              parentStreamId: root.id,
              rootStreamId: root.id,
              createdBy: users.author.id,
            })
          : root
        const message = await eventService.createMessage({
          workspaceId: users.ws,
          streamId: posted.id,
          authorId: users.author.id,
          authorType: AuthorTypes.USER,
          ...testMessageContent(text),
        })
        // Marked after posting: the stored message then carries the wire placeholder an E2E client sends.
        if (e2e) {
          await E2eStreamsRepository.markStreamE2e(pool, {
            streamId: root.id,
            workspaceId: users.ws,
            ownerUserId: users.author.id,
            ownerUserKeyId: "e2ek_owner",
          })
        }
        const saved = await savedService.save({
          workspaceId: users.ws,
          userId: users.recipient.id,
          messageId: message.id,
          remindAt: new Date(Date.now() + HOUR_MS),
        })
        expect(
          await savedService.markReminderFired({ workspaceId: users.ws, userId: users.recipient.id, savedId: saved.id })
        ).toEqual({ fired: true })
        const outbox = await pool.query(
          `SELECT id, payload, created_at FROM outbox
           WHERE event_type = 'saved_reminder:fired' AND payload->>'savedId' = $1 ORDER BY id DESC LIMIT 1`,
          [saved.id]
        )
        const row = outbox.rows[0]
        const source: PushSourceEvent = { id: BigInt(row.id), createdAt: row.created_at }
        return { ...users, posted, saved, source, payload: row.payload as SavedReminderFiredOutboxPayload }
      }

      test("should arm a receipt for a consenting user's plaintext reminder, never under a root encrypted since, nor for a default user", async () => {
        const service = createService()
        const hashOf = (token: string) => createHash("sha256").update(token).digest("hex")
        const cases = [
          { name: "consenting plaintext", consent: true, e2e: false, inThread: false },
          { name: "default consent", consent: false, e2e: false, inThread: false },
          { name: "old plaintext under an encrypted root", consent: true, e2e: true, inThread: false },
          { name: "old plaintext in a thread under an encrypted root", consent: true, e2e: true, inThread: true },
        ]
        const observed: Record<string, unknown> = {}
        const expected: Record<string, unknown> = {}
        for (const c of cases) {
          const ctx = await firedReminder("remember this", c.e2e, c.inThread)
          if (c.consent) {
            await preferencesService.updatePreferences(ctx.ws, ctx.recipient.id, {
              [ANALYTICS_CONSENT_KEY]: ANALYTICS_CONSENT_GRANTED,
            })
          }
          const sub = await subscribe(ctx.ws, ctx.recipient.id, `https://push.example.com/${ctx.ws}`, 1)
          await service.planSavedReminderPush(ctx.source, ctx.payload)
          await drainDuePushJobs(pool, service, ctx.ws)
          const [sent] = sendsTo(sub.endpoint)
          const token = sent?.receipt?.token ?? null
          const { rows } = await pool.query(
            `SELECT token_hash, stream_id, consent_generation::text AS consent_generation FROM push_receipts WHERE workspace_id = $1`,
            [ctx.ws]
          )
          const grant = await preferencesService.findAnalyticsConsentGrant(pool, ctx.recipient.id)
          observed[c.name] = {
            sent: sent !== undefined,
            tokenInData: JSON.stringify(sent?.data ?? {}).includes(token ?? "no token sent"),
            receiptInData: "receipt" in (sent?.data ?? {}),
            receipts: rows,
          }
          const armed = c.consent && !c.e2e
          expected[c.name] = {
            sent: true,
            tokenInData: false,
            receiptInData: false,
            receipts: armed
              ? [
                  {
                    token_hash: token === null ? "no token sent" : hashOf(token),
                    stream_id: ctx.posted.id,
                    consent_generation: grant,
                  },
                ]
              : [],
          }
        }

        expect(observed).toEqual(expected)
      })

      test("should push the fired generation and drop the retry once the reminder is cancelled", async () => {
        const service = createService()
        const ctx = await firedReminder()
        const sub = await subscribe(ctx.ws, ctx.recipient.id, `https://push.example.com/${ctx.ws}`)
        scripts.set(sub.endpoint, [failing(503)])

        await service.planSavedReminderPush(ctx.source, ctx.payload)
        await drainDuePushJobs(pool, service, ctx.ws)
        await savedService.updateReminder({
          workspaceId: ctx.ws,
          userId: ctx.recipient.id,
          savedId: ctx.saved.id,
          remindAt: null,
        })
        await makeDeliveryDue(pool, (await deliveries(ctx.ws))[0]!.id)
        await drainDuePushJobs(pool, service, ctx.ws)

        expect(typeof ctx.payload.reminderGeneration).toBe("number")
        expect(sendsTo(sub.endpoint).map((s) => ({ kind: s.data.kind, preview: s.data.contentPreview }))).toEqual([
          { kind: "saved_reminder", preview: "remember this" },
        ])
        expect((await deliveries(ctx.ws))[0]).toMatchObject({ status: "suppressed", terminalReason: "source_gone" })
      })

      test("should preview an end-to-end encrypted saved message as the encrypted label, never its placeholder", async () => {
        const service = createService()
        const ctx = await firedReminder(E2E_PLACEHOLDER_CONTENT_MARKDOWN, true)
        const sub = await subscribe(ctx.ws, ctx.recipient.id, `https://push.example.com/${ctx.ws}`)

        await service.planSavedReminderPush(ctx.source, ctx.payload)
        await drainDuePushJobs(pool, service, ctx.ws)

        expect(sendsTo(sub.endpoint).map((s) => s.data.contentPreview)).toEqual([ENCRYPTED_MESSAGE_PREVIEW_LABEL])
      })

      test("should send a legacy event without a generation once, inline, with no ledger rows or retries", async () => {
        const service = createService()
        const ctx = await firedReminder()
        const sub = await subscribe(ctx.ws, ctx.recipient.id, `https://push.example.com/${ctx.ws}`)
        scripts.set(sub.endpoint, [failing(503)])
        const { reminderGeneration: _dropped, ...legacy } = ctx.payload

        await service.planSavedReminderPush(ctx.source, legacy)

        expect({
          sends: sendsTo(sub.endpoint).length,
          plans: await planCount(ctx.ws),
          jobs: (await listPushJobs(pool, ctx.ws)).length,
        }).toEqual({ sends: 1, plans: 0, jobs: 0 })
      })
    })
  })
})
