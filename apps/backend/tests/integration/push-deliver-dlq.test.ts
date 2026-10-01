import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, spyOn } from "bun:test"
import type { Pool } from "pg"
import webpush from "web-push"
import { randomBytes } from "node:crypto"
import {
  ActivityTypes,
  PrefNotificationLevels,
  StreamTypes,
  DEFAULT_PUSH_ACTIONS,
  DEFAULT_PUSH_REMINDER_MINUTES,
  DEFAULT_PUSH_QUICK_REACTION,
} from "@threahq/types"
import { DisabledAnalyticsReporter, attachPostHogLogShipping, logger } from "@threahq/backend-common"
import {
  PushDeliveryRepository,
  PushService,
  PushSubscriptionRepository,
  PushTelemetry,
  createPushDeliverOnDLQ,
  createPushDeliverWorker,
  type PushSourceEvent,
} from "../../src/features/push"
import {
  JobQueues,
  QueueManager,
  QueueRepository,
  TokenPoolRepository,
  type JobHandler,
  type OnDLQHook,
  type PushDeliverJobData,
} from "../../src/lib/queue"
import type { ActivityCreatedOutboxPayload } from "../../src/lib/outbox"
import { activityId, messageId, userId, workspaceId } from "../../src/lib/id"
import { setupIsolatedTestDatabase } from "./setup"
import { listPushJobs, makeDeliveryDue, runPushJob } from "./push-queue-helpers"

async function waitFor(check: () => Promise<boolean>, timeoutMs: number, message: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(message)
}

describe("dead-lettered push delivery jobs", () => {
  let pool: Pool
  let cleanup: () => Promise<void>
  let sendSpy: ReturnType<typeof spyOn>
  let nextEventId = BigInt(Date.now()) * 1000n
  let ws: string
  let uid: string

  beforeAll(async () => {
    // Own database: the real QueueManager below claims every open push job it can see.
    const isolated = await setupIsolatedTestDatabase("push_deliver_dlq")
    pool = isolated.pool
    cleanup = isolated.cleanup
    sendSpy = spyOn(webpush, "sendNotification")
  }, 120_000)

  afterAll(async () => {
    sendSpy.mockRestore()
    await cleanup()
  }, 120_000)

  beforeEach(() => {
    ws = workspaceId()
    uid = userId()
    sendSpy.mockReset()
    sendSpy.mockImplementation((() => Promise.resolve({ statusCode: 201, body: "", headers: {} })) as never)
  })

  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore()
  })

  const spies: Array<{ mockRestore: () => void }> = []

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
        getWorkosUserId: async () => "user_WORKOS",
        resolveActivityPush: async () => ({
          valid: true,
          source: {
            activityId: "act",
            activityType: ActivityTypes.MENTION,
            streamId: "stream_01PLANNED",
            messageId: "msg_1",
            contentMarkdown: "hello",
            encrypted: false,
            streamName: "#general",
            authorName: "Ada",
            emoji: null,
            mode: null,
          },
        }),
        resolveFiredReminder: async () => null,
        isRewrapOutstanding: async () => false,
      },
    })
  }

  function event(): PushSourceEvent {
    return { id: nextEventId++, createdAt: new Date() }
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

  /** One planned delivery per name, keyed by name. */
  async function planDeliveries<N extends string>(
    service: PushService,
    names: readonly N[]
  ): Promise<Record<N, { id: string; endpoint: string }>> {
    const bySub = new Map<string, N>()
    const endpoints = new Map<N, string>()
    for (const name of names) {
      const endpoint = `https://push.example.com/${name}`
      const sub = await PushSubscriptionRepository.insert(pool, {
        workspaceId: ws,
        userId: uid,
        endpoint,
        p256dh: webpush.generateVAPIDKeys().publicKey,
        auth: randomBytes(16).toString("base64url"),
        deviceKey: `device-${name}`,
      })
      bySub.set(sub.id, name)
      endpoints.set(name, endpoint)
    }
    await service.planActivityPush(event(), activityPayload())
    const rows = await pool.query<{ id: string; subscription_id: string }>(
      `SELECT id, subscription_id FROM push_deliveries WHERE workspace_id = $1`,
      [ws]
    )
    const out = {} as Record<N, { id: string; endpoint: string }>
    for (const row of rows.rows) {
      const name = bySub.get(row.subscription_id)!
      out[name] = { id: row.id, endpoint: endpoints.get(name)! }
    }
    return out
  }

  async function row(id: string) {
    const result = await pool.query<{
      status: string
      terminal_reason: string | null
      attempts: number
      version: number
      lease_expires_at: Date | null
    }>(`SELECT status, terminal_reason, attempts, version, lease_expires_at FROM push_deliveries WHERE id = $1`, [id])
    const r = result.rows[0]!
    return {
      status: r.status,
      reason: r.terminal_reason,
      attempts: r.attempts,
      version: r.version,
      leaseExpiresAt: r.lease_expires_at,
    }
  }

  test("should fail a stranded delivery, leave live and failing ones pending, and keep ids and errors out of shipped logs", async () => {
    const service = createService()
    const d = await planDeliveries(service, ["stranded", "successor", "hookFails", "orphanLease"] as const)

    const [successorJob] = (await listPushJobs(pool, ws)).filter((j) => j.payload.deliveryId === d.successor.id)
    await QueueRepository.insert(pool, {
      id: `${d.successor.id}_a0_live`,
      queueName: JobQueues.PUSH_DELIVER,
      workspaceId: ws,
      payload: successorJob!.payload,
      processAfter: new Date(Date.now() + 60 * 60 * 1000),
      insertedAt: new Date(),
    })
    // A worker that crashed mid-send: its lease is live, yet no job of its own will ever run again.
    const orphan = await PushDeliveryRepository.claim(pool, {
      workspaceId: ws,
      deliveryId: d.orphanLease.id,
      attempt: 0,
      leaseMs: 60_000,
    })
    const orphanLease = await row(d.orphanLease.id)

    const realClaim = PushDeliveryRepository.claim.bind(PushDeliveryRepository)
    spies.push(
      spyOn(PushDeliveryRepository, "claim").mockImplementation(async (db, params) => {
        if (db === pool || params.deliveryId === d.hookFails.id) {
          await new Promise((resolve) => setTimeout(resolve, 60))
          throw new Error(`claim failed for ${params.deliveryId} in ${params.workspaceId}`)
        }
        return realClaim(db, params)
      }),
      spyOn(QueueRepository, "batchRenewClaims").mockImplementation(async (_db, params) => {
        throw new Error(`renew failed for ${params.messageIds.join(",")} in ${ws}`)
      }),
      spyOn(TokenPoolRepository, "renewLease").mockImplementation(async () => {
        throw new Error(`token renew failed in ${ws}`)
      })
    )

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

    const manager = new QueueManager({
      pool,
      queueRepository: QueueRepository,
      tokenPoolRepository: TokenPoolRepository,
      maxRetries: 2,
      baseBackoffMs: 1,
      pollIntervalMs: 20,
      refreshIntervalMs: 10,
      lockDurationMs: 5000,
    })
    manager.registerHandler(
      JobQueues.PUSH_DELIVER,
      createPushDeliverWorker({ pushService: service }) as JobHandler<unknown>,
      {
        hooks: { onDLQ: createPushDeliverOnDLQ({ pushService: service }) as OnDLQHook<unknown> },
        privateLogs: true,
      }
    )
    const originalJobIds = Object.values(d).map((x) => `${x.id}_a0`)
    manager.start()
    try {
      await waitFor(
        async () => {
          const jobs = await listPushJobs(pool, ws)
          return originalJobIds.every((id) => jobs.find((j) => j.id === id)?.deadLettered)
        },
        15_000,
        "push jobs never dead-lettered"
      )
    } finally {
      await manager.stop()
      await shipper.flush()
      await shipper.shutdown()
      logger.level = levelBefore
    }

    const wake = (await listPushJobs(pool, ws)).find(
      (j) => j.payload.deliveryId === d.orphanLease.id && j.id !== `${d.orphanLease.id}_a0`
    )
    const lastError = await pool.query<{ last_error: string }>(`SELECT last_error FROM queue_messages WHERE id = $1`, [
      `${d.stranded.id}_a0`,
    ])
    expect({
      stranded: await row(d.stranded.id),
      successor: (await row(d.successor.id)).status,
      hookFails: (await row(d.hookFails.id)).status,
      orphan: { status: (await row(d.orphanLease.id)).status, wakeId: wake?.id, wakeAt: wake?.processAfter.getTime() },
      lastError: lastError.rows[0]!.last_error,
    }).toEqual({
      stranded: { status: "failed", reason: "infrastructure", attempts: 0, version: 2, leaseExpiresAt: null },
      successor: "pending",
      hookFails: "pending",
      orphan: {
        status: "pending",
        wakeId: `${d.orphanLease.id}_a0_v${orphan!.version}_w1`,
        wakeAt: orphanLease.leaseExpiresAt!.getTime() + 1000,
      },
      lastError: `claim failed for ${d.stranded.id} in ${ws}`,
    })

    const exported = shipped.join("\n")
    const leaks = [ws, "push_del_", "claim failed", "renew failed", "token renew failed"].filter((s) =>
      exported.includes(s)
    )
    const bodies = [
      "Message processing failed",
      "Message moved to DLQ after exhausting retries",
      "onDLQ hook failed - DLQ move will still commit",
      "Failed to batch renew claims",
      "Failed to renew token lease",
      "Message scheduled for retry",
    ].filter((s) => !exported.includes(s))
    expect({ leaks, missingBodies: bodies }).toEqual({ leaks: [], missingBodies: [] })

    for (const spy of spies.splice(0)) spy.mockRestore()
    await makeDeliveryDue(pool, d.orphanLease.id)
    await runPushJob(pool, service, { ...wake!, processAfter: new Date() })
    expect({
      orphan: (await row(d.orphanLease.id)).status,
      sends: sendSpy.mock.calls.map((c) => (c[0] as { endpoint: string }).endpoint),
    }).toEqual({ orphan: "accepted", sends: [d.orphanLease.endpoint] })
  })

  test("should leave the delivery alone when the hook runs for a job that was not dead-lettered or a delivery already accepted", async () => {
    const service = createService()
    const hook = createPushDeliverOnDLQ({ pushService: service })
    const d = await planDeliveries(service, ["stale", "accepted"] as const)
    const jobs = await listPushJobs(pool, ws)
    const jobFor = (id: string) => jobs.find((j) => j.payload.deliveryId === id)!

    await runPushJob(pool, service, jobFor(d.accepted.id))
    await pool.query(`UPDATE queue_messages SET dlq_at = NOW() WHERE id = $1`, [jobFor(d.accepted.id).id])
    const before = { stale: await row(d.stale.id), accepted: await row(d.accepted.id) }

    const meta = { failedCount: 1, insertedAt: new Date(), workspaceId: ws }
    for (const name of ["stale", "accepted"] as const) {
      const job = jobFor(d[name].id)
      await hook(
        pool,
        { id: job.id, name: JobQueues.PUSH_DELIVER, data: job.payload as unknown as PushDeliverJobData },
        new Error("boom"),
        meta
      )
    }

    expect({
      rows: { stale: await row(d.stale.id), accepted: await row(d.accepted.id) },
      jobs: (await listPushJobs(pool, ws)).map((j) => j.id).sort(),
    }).toEqual({ rows: before, jobs: jobs.map((j) => j.id).sort() })
    expect(before.accepted.status).toBe("accepted")
  })

  test("should fail the delivery when two jobs for the same attempt dead-letter in overlapping transactions", async () => {
    const service = createService()
    const hook = createPushDeliverOnDLQ({ pushService: service })
    const d = await planDeliveries(service, ["raced"] as const)
    const [original] = await listPushJobs(pool, ws)
    const sibling = `${d.raced.id}_a0_sibling`
    await QueueRepository.insert(pool, {
      id: sibling,
      queueName: JobQueues.PUSH_DELIVER,
      workspaceId: ws,
      payload: original!.payload,
      processAfter: new Date(),
      insertedAt: new Date(),
    })
    await pool.query(`UPDATE queue_messages SET claimed_by = 'worker' WHERE id = ANY($1::text[])`, [
      [original!.id, sibling],
    ])

    const meta = { failedCount: 10, insertedAt: new Date(), workspaceId: ws }
    const first = await pool.connect()
    const second = await pool.connect()
    try {
      await first.query("BEGIN")
      await second.query("BEGIN")
      for (const [client, id] of [
        [first, original!.id],
        [second, sibling],
      ] as const) {
        await QueueRepository.failDlq(client, { messageId: id, claimedBy: "worker", error: "boom", dlqAt: new Date() })
      }
      const runHook = (client: typeof first, id: string) =>
        hook(
          client,
          { id, name: JobQueues.PUSH_DELIVER, data: original!.payload as unknown as PushDeliverJobData },
          new Error("boom"),
          meta
        )

      // Each hook sees the other job's dead-lettering uncommitted, so the other still looks open.
      await runHook(first, original!.id)
      const secondHook = runHook(second, sibling)
      await new Promise((resolve) => setTimeout(resolve, 100))
      await first.query("COMMIT")
      await secondHook
      await second.query("COMMIT")
    } finally {
      await first.query("ROLLBACK").catch(() => {})
      await second.query("ROLLBACK").catch(() => {})
      first.release()
      second.release()
    }

    expect(await row(d.raced.id)).toEqual({
      status: "failed",
      reason: "infrastructure",
      attempts: 0,
      version: 2,
      leaseExpiresAt: null,
    })
  })
})
