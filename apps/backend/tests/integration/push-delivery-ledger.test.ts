import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import type { Pool } from "pg"
import { randomBytes } from "node:crypto"
import { PushSubscriptionRepository } from "../../src/features/push"
import {
  PushDeliveryRepository,
  PUSH_DELIVERY_STATUSES,
  type PlanPushDeliveryParams,
} from "../../src/features/push/delivery-repository"
import { QueueRepository } from "../../src/lib/queue"
import { createTestPool, setupTestDatabase, withTransaction } from "./setup"
import { userId, workspaceId } from "../../src/lib/id"

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
const LEASE_MS = 60_000
const TEST_QUEUE = "push.deliver.ledger-test"

let nextEventId = BigInt(Date.now()) * 1000n

function sourceEventId(): bigint {
  nextEventId += 1n
  return nextEventId
}

function keys(): { p256dh: string; auth: string } {
  return { p256dh: randomBytes(65).toString("base64url"), auth: randomBytes(16).toString("base64url") }
}

describe("push delivery ledger", () => {
  let pool: Pool

  beforeAll(async () => {
    pool = await setupTestDatabase()
  })

  afterAll(async () => {
    await pool.query("DELETE FROM queue_messages WHERE queue_name = $1", [TEST_QUEUE])
    await pool.end()
  })

  async function subscribe(
    ws: string,
    uid: string,
    endpoint = `https://push.example/${randomBytes(6).toString("hex")}`
  ) {
    return PushSubscriptionRepository.insert(pool, {
      workspaceId: ws,
      userId: uid,
      endpoint,
      ...keys(),
      deviceKey: "device-1",
    })
  }

  function planParams(
    ws: string,
    uid: string,
    overrides: Partial<PlanPushDeliveryParams> = {}
  ): PlanPushDeliveryParams {
    const createdAt = new Date()
    return {
      workspaceId: ws,
      userId: uid,
      kind: "activity",
      sourceEventId: sourceEventId(),
      sourceId: "activity_source",
      sourceGeneration: null,
      sourceCreatedAt: createdAt,
      expiresAt: new Date(createdAt.getTime() + DAY_MS),
      subscriptions: [],
      ...overrides,
    }
  }

  async function deviceRow(id: string) {
    const result = await pool.query(
      `SELECT status, attempts, version, last_outcome, last_status_code, terminal_reason,
              accepted_at IS NOT NULL AS accepted, next_attempt_at
       FROM push_deliveries WHERE id = $1`,
      [id]
    )
    return result.rows[0] ?? null
  }

  async function planOne(overrides: Partial<PlanPushDeliveryParams> = {}) {
    const ws = workspaceId()
    const uid = userId()
    const sub = await subscribe(ws, uid)
    const planned = await PushDeliveryRepository.insertPlan(
      pool,
      planParams(ws, uid, { subscriptions: [{ id: sub.id, generation: sub.generation }], ...overrides })
    )
    return { ws, uid, sub, planned: planned!, device: planned!.devices[0]! }
  }

  describe("subscription generation", () => {
    test("should keep the generation when the same binding re-registers and bump it when keys change", async () => {
      const ws = workspaceId()
      const uid = userId()
      const endpoint = "https://push.example/rereg"
      const bound = keys()
      const first = await PushSubscriptionRepository.insert(pool, {
        workspaceId: ws,
        userId: uid,
        endpoint,
        ...bound,
        deviceKey: "d1",
      })
      const same = await PushSubscriptionRepository.insert(pool, {
        workspaceId: ws,
        userId: uid,
        endpoint,
        ...bound,
        deviceKey: "d1",
        userAgent: "new agent",
      })
      const rekeyed = await PushSubscriptionRepository.insert(pool, {
        workspaceId: ws,
        userId: uid,
        endpoint,
        ...keys(),
        deviceKey: "d1",
      })
      const moved = await PushSubscriptionRepository.insert(pool, {
        workspaceId: ws,
        userId: uid,
        endpoint,
        p256dh: rekeyed.p256dh,
        auth: rekeyed.auth,
        deviceKey: "d2",
      })

      expect([first, same, rekeyed, moved].map((s) => ({ id: s.id, generation: s.generation }))).toEqual([
        { id: first.id, generation: 1 },
        { id: first.id, generation: 1 },
        { id: first.id, generation: 2 },
        { id: first.id, generation: 3 },
      ])
    })

    test("should bump the generation for an old-build writer that never names the column", async () => {
      const ws = workspaceId()
      const uid = userId()
      const sub = await subscribe(ws, uid)
      const oldUpsert = `
        INSERT INTO push_subscriptions (id, workspace_id, user_id, endpoint, p256dh, auth, device_key, user_agent)
        VALUES ('push_sub_ignored', $1, $2, $3, $4, $5, $6, NULL)
        ON CONFLICT (workspace_id, user_id, endpoint) DO UPDATE SET
          p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, device_key = EXCLUDED.device_key,
          user_agent = EXCLUDED.user_agent, updated_at = now()
        RETURNING generation`

      const sameBinding = await pool.query(oldUpsert, [ws, uid, sub.endpoint, sub.p256dh, sub.auth, sub.deviceKey])
      const newAuth = keys().auth
      const rekey = await pool.query(oldUpsert, [ws, uid, sub.endpoint, sub.p256dh, newAuth, sub.deviceKey])
      const forged = await pool.query(
        "UPDATE push_subscriptions SET generation = 1 WHERE id = $1 RETURNING generation",
        [sub.id]
      )

      expect([sameBinding.rows[0].generation, rekey.rows[0].generation, forged.rows[0].generation]).toEqual([1, 2, 2])
    })

    test("should delete a subscription only at the observed generation", async () => {
      const ws = workspaceId()
      const uid = userId()
      const sub = await subscribe(ws, uid)
      await PushSubscriptionRepository.insert(pool, {
        workspaceId: ws,
        userId: uid,
        endpoint: sub.endpoint,
        ...keys(),
        deviceKey: sub.deviceKey,
      })

      const stale = await PushSubscriptionRepository.deleteByIdsAtGeneration(pool, ws, [{ id: sub.id, generation: 1 }])
      const otherWorkspace = await PushSubscriptionRepository.deleteByIdsAtGeneration(pool, workspaceId(), [
        { id: sub.id, generation: 2 },
      ])
      const current = await PushSubscriptionRepository.deleteByIdsAtGeneration(pool, ws, [
        { id: sub.id, generation: 2 },
      ])

      expect({ stale, otherWorkspace, current }).toEqual({ stale: [], otherWorkspace: [], current: [sub.id] })
    })
  })

  describe("planning", () => {
    test("should plan once per source event and recipient and plan nothing on replay", async () => {
      const ws = workspaceId()
      const uid = userId()
      const a = await subscribe(ws, uid)
      const b = await subscribe(ws, uid)
      const params = planParams(ws, uid, {
        subscriptions: [
          { id: a.id, generation: a.generation },
          { id: b.id, generation: b.generation },
        ],
      })

      const first = await PushDeliveryRepository.insertPlan(pool, params)
      const replay = await PushDeliveryRepository.insertPlan(pool, params)
      const rows = await pool.query(
        `SELECT d.subscription_id, d.subscription_generation, d.status, d.attempts
         FROM push_deliveries d JOIN push_delivery_plans p ON p.id = d.plan_id
         WHERE p.workspace_id = $1 AND p.source_event_id = $2 ORDER BY d.subscription_id`,
        [ws, params.sourceEventId.toString()]
      )

      expect(first!.devices.map((d) => d.subscriptionId).sort()).toEqual([a.id, b.id].sort())
      expect(replay).toBeNull()
      expect(rows.rows).toEqual(
        [a.id, b.id]
          .sort()
          .map((id) => ({ subscription_id: id, subscription_generation: 1, status: "pending", attempts: 0 }))
      )
    })

    test("should commit the plan and its device jobs together or not at all", async () => {
      const ws = workspaceId()
      const uid = userId()
      const sub = await subscribe(ws, uid)
      const params = planParams(ws, uid, { subscriptions: [{ id: sub.id, generation: sub.generation }] })
      const enqueue = async (client: Parameters<Parameters<typeof withTransaction>[1]>[0]) => {
        const planned = await PushDeliveryRepository.insertPlan(client, params)
        if (!planned) return []
        const now = new Date()
        return QueueRepository.batchInsert(
          client,
          planned.devices.map((device) => ({
            id: `queue_${device.id}_0`,
            queueName: TEST_QUEUE,
            workspaceId: ws,
            payload: { workspaceId: ws, deliveryId: device.id, attempt: 0 },
            processAfter: now,
            insertedAt: now,
          }))
        )
      }

      await expect(
        withTransaction(pool, async (client) => {
          await enqueue(client)
          throw new Error("crash before commit")
        })
      ).rejects.toThrow("crash before commit")
      const afterRollback = await pool.query(
        "SELECT COUNT(*)::int AS n FROM push_delivery_plans WHERE workspace_id = $1",
        [ws]
      )

      const committed = await withTransaction(pool, enqueue)
      const replayed = await withTransaction(pool, enqueue)
      const jobs = await pool.query("SELECT payload FROM queue_messages WHERE queue_name = $1 AND workspace_id = $2", [
        TEST_QUEUE,
        ws,
      ])

      expect(afterRollback.rows[0].n).toBe(0)
      expect(committed).toHaveLength(1)
      expect(replayed).toEqual([])
      expect(jobs.rows.map((r) => r.payload)).toEqual([
        { workspaceId: ws, deliveryId: committed[0]!.id.replace(/^queue_(.*)_0$/, "$1"), attempt: 0 },
      ])
    })
  })

  describe("claims", () => {
    test("should let exactly one of two concurrent workers claim a device delivery", async () => {
      const { ws, device } = await planOne()
      const second = createTestPool()
      try {
        const results = await Promise.all([
          PushDeliveryRepository.claim(pool, { workspaceId: ws, deliveryId: device.id, attempt: 0, leaseMs: LEASE_MS }),
          PushDeliveryRepository.claim(second, {
            workspaceId: ws,
            deliveryId: device.id,
            attempt: 0,
            leaseMs: LEASE_MS,
          }),
        ])
        expect(results.filter((r) => r !== null)).toHaveLength(1)
      } finally {
        await second.end()
      }
    })

    test("should return the pinned subscription while its generation matches and null after a re-key or delete", async () => {
      const { ws, uid, sub, device } = await planOne()
      const claimed = await PushDeliveryRepository.claim(pool, {
        workspaceId: ws,
        deliveryId: device.id,
        attempt: 0,
        leaseMs: 0,
      })
      await PushSubscriptionRepository.insert(pool, {
        workspaceId: ws,
        userId: uid,
        endpoint: sub.endpoint,
        ...keys(),
        deviceKey: sub.deviceKey,
      })
      const afterRekey = await PushDeliveryRepository.claim(pool, {
        workspaceId: ws,
        deliveryId: device.id,
        attempt: 0,
        leaseMs: 0,
      })

      expect(claimed).toEqual({
        id: device.id,
        workspaceId: ws,
        userId: uid,
        kind: "activity",
        sourceEventId: expect.any(BigInt),
        sourceId: "activity_source",
        sourceGeneration: null,
        sourceCreatedAt: expect.any(Date),
        expiresAt: expect.any(Date),
        attempts: 0,
        version: 1,
        abandonedClaims: 0,
        subscriptionId: sub.id,
        subscriptionGeneration: 1,
        subscription: { endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth },
      })
      expect(afterRekey).toMatchObject({ version: 2, subscription: null })
    })

    test("should refuse a claim while another lease is live, then let a reclaim win over the stale holder", async () => {
      const { ws, device } = await planOne()
      const stale = await PushDeliveryRepository.claim(pool, {
        workspaceId: ws,
        deliveryId: device.id,
        attempt: 0,
        leaseMs: 0,
      })
      const takeover = await PushDeliveryRepository.claim(pool, {
        workspaceId: ws,
        deliveryId: device.id,
        attempt: 0,
        leaseMs: LEASE_MS,
      })
      const whileLeased = await PushDeliveryRepository.claim(pool, {
        workspaceId: ws,
        deliveryId: device.id,
        attempt: 0,
        leaseMs: LEASE_MS,
      })
      const staleSettle = await PushDeliveryRepository.settle(pool, {
        workspaceId: ws,
        deliveryId: device.id,
        claimVersion: stale!.version,
        settlement: {
          kind: "terminal",
          status: PUSH_DELIVERY_STATUSES.ACCEPTED,
          attempted: true,
          outcome: "accepted",
          statusCode: 201,
          reason: null,
        },
      })

      expect({ stale: stale?.version, takeover: takeover?.version, whileLeased, staleSettle }).toEqual({
        stale: 1,
        takeover: 2,
        whileLeased: null,
        staleSettle: null,
      })
    })
  })

  describe("settling", () => {
    test("should schedule a retry that only the next attempt can claim once its time arrives", async () => {
      const { ws, device } = await planOne()
      const first = await PushDeliveryRepository.claim(pool, {
        workspaceId: ws,
        deliveryId: device.id,
        attempt: 0,
        leaseMs: LEASE_MS,
      })
      const retry = await PushDeliveryRepository.settle(pool, {
        workspaceId: ws,
        deliveryId: device.id,
        claimVersion: first!.version,
        settlement: {
          kind: "retry",
          nextAttemptAt: new Date(Date.now() + HOUR_MS),
          outcome: "unreachable",
          statusCode: 503,
        },
      })
      const duplicateFirstJob = await PushDeliveryRepository.claim(pool, {
        workspaceId: ws,
        deliveryId: device.id,
        attempt: 0,
        leaseMs: LEASE_MS,
      })
      const earlyRetryJob = await PushDeliveryRepository.claim(pool, {
        workspaceId: ws,
        deliveryId: device.id,
        attempt: 1,
        leaseMs: LEASE_MS,
      })

      expect({ retry, duplicateFirstJob, earlyRetryJob }).toEqual({
        retry: { id: device.id, status: "pending", attempts: 1, version: 2 },
        duplicateFirstJob: null,
        earlyRetryJob: null,
      })
      expect(await deviceRow(device.id)).toEqual({
        status: "pending",
        attempts: 1,
        version: 2,
        last_outcome: "unreachable",
        last_status_code: 503,
        terminal_reason: null,
        accepted: false,
        next_attempt_at: expect.any(Date),
      })
    })

    test("should never claim an accepted delivery again on job or cursor replay", async () => {
      const { ws, device } = await planOne()
      const first = await PushDeliveryRepository.claim(pool, {
        workspaceId: ws,
        deliveryId: device.id,
        attempt: 0,
        leaseMs: LEASE_MS,
      })
      const retry = await PushDeliveryRepository.settle(pool, {
        workspaceId: ws,
        deliveryId: device.id,
        claimVersion: first!.version,
        settlement: {
          kind: "retry",
          nextAttemptAt: new Date(Date.now() - 1000),
          outcome: "unreachable",
          statusCode: 429,
        },
      })
      const second = await PushDeliveryRepository.claim(pool, {
        workspaceId: ws,
        deliveryId: device.id,
        attempt: 1,
        leaseMs: LEASE_MS,
      })
      const accepted = await PushDeliveryRepository.settle(pool, {
        workspaceId: ws,
        deliveryId: device.id,
        claimVersion: second!.version,
        settlement: {
          kind: "terminal",
          status: PUSH_DELIVERY_STATUSES.ACCEPTED,
          attempted: true,
          outcome: "accepted",
          statusCode: 201,
          reason: null,
        },
      })
      const replays = await Promise.all(
        [0, 1, 2].map((attempt) =>
          PushDeliveryRepository.claim(pool, { workspaceId: ws, deliveryId: device.id, attempt, leaseMs: 0 })
        )
      )

      expect({ retry: retry?.status, accepted, replays }).toEqual({
        retry: "pending",
        accepted: { id: device.id, status: "accepted", attempts: 2, version: 4 },
        replays: [null, null, null],
      })
      expect(await deviceRow(device.id)).toMatchObject({ accepted: true, last_status_code: 201, next_attempt_at: null })
    })

    test("should settle a pre-send suppression without counting an attempt", async () => {
      const { ws, device } = await planOne()
      const claimed = await PushDeliveryRepository.claim(pool, {
        workspaceId: ws,
        deliveryId: device.id,
        attempt: 0,
        leaseMs: LEASE_MS,
      })
      const settled = await PushDeliveryRepository.settle(pool, {
        workspaceId: ws,
        deliveryId: device.id,
        claimVersion: claimed!.version,
        settlement: {
          kind: "terminal",
          status: PUSH_DELIVERY_STATUSES.SUPPRESSED,
          attempted: false,
          outcome: null,
          statusCode: null,
          reason: "read",
        },
      })

      expect(settled).toEqual({ id: device.id, status: "suppressed", attempts: 0, version: 2 })
      expect(await deviceRow(device.id)).toMatchObject({ terminal_reason: "read", last_outcome: null })
    })
  })

  describe("retention", () => {
    test("should delete plans and devices past the cutoff and keep live ones", async () => {
      const old = await planOne({ expiresAt: new Date(Date.now() - 8 * DAY_MS) })
      const live = await planOne()

      let deleted = 0
      for (;;) {
        const n = await PushDeliveryRepository.deleteExpiredPlans(pool, {
          expiredBefore: new Date(Date.now() - 7 * DAY_MS),
          limit: 500,
        })
        deleted += n
        if (n === 0) break
      }
      const remaining = await pool.query(
        `SELECT p.id AS plan_id, d.id AS device_id FROM push_delivery_plans p
         LEFT JOIN push_deliveries d ON d.plan_id = p.id WHERE p.id = ANY($1::text[]) ORDER BY p.id`,
        [[old.planned.planId, live.planned.planId]]
      )
      const orphans = await pool.query("SELECT id FROM push_deliveries WHERE id = $1", [old.device.id])

      expect(deleted).toBeGreaterThanOrEqual(1)
      expect(remaining.rows).toEqual([{ plan_id: live.planned.planId, device_id: live.device.id }])
      expect(orphans.rows).toEqual([])
    })
  })
})
