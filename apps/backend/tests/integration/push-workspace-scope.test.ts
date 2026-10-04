import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import { randomBytes } from "node:crypto"
import { PushReceiptRepository, PushService, PushSubscriptionRepository, PushTelemetry } from "../../src/features/push"
import { DisabledAnalyticsReporter } from "@threahq/backend-common"
import { PushDeliveryRepository } from "../../src/features/push/delivery-repository"
import { PUSH_RECEIPT_SCOPES } from "../../src/features/push/receipt-repository"
import { addTestMember, setupTestDatabase } from "./setup"
import {
  pushDeliveryId,
  pushDeliveryPlanId,
  pushReceiptId,
  pushSubscriptionId,
  userId,
  workspaceId,
} from "../../src/lib/id"

const DAY_MS = 24 * 60 * 60 * 1000

describe("Push repositories workspace scope (INV-8)", () => {
  let nextSourceEventId = BigInt(Date.now()) * 1000n
  let pool: Pool
  let wsA: string
  let wsB: string

  beforeAll(async () => {
    pool = await setupTestDatabase()
    wsA = workspaceId()
    wsB = workspaceId()
  })

  afterAll(async () => {
    await pool.end()
  })

  async function subscribe(wid: string, uid: string, endpoint: string) {
    return PushSubscriptionRepository.insert(pool, {
      workspaceId: wid,
      userId: uid,
      endpoint,
      p256dh: randomBytes(65).toString("base64url"),
      auth: randomBytes(16).toString("base64url"),
      deviceKey: `device-${endpoint}`,
    })
  }

  async function seedPlan(wid: string, expiresAt: Date) {
    const id = pushDeliveryPlanId()
    nextSourceEventId += 1n
    await pool.query(
      `INSERT INTO push_delivery_plans (id, workspace_id, user_id, kind, source_event_id, source_id, source_created_at, expires_at)
       VALUES ($1, $2, $3, 'activity', $4, 'activity_source', now(), $5)`,
      [id, wid, userId(), nextSourceEventId.toString(), expiresAt]
    )
    return id
  }

  async function seedDevice(wid: string, planId: string) {
    const id = pushDeliveryId()
    await pool.query(
      `INSERT INTO push_deliveries (id, workspace_id, plan_id, subscription_id, subscription_generation)
       VALUES ($1, $2, $3, $4, 1)`,
      [id, wid, planId, pushSubscriptionId()]
    )
    return id
  }

  async function seedReceipt(wid: string, retainUntil: Date) {
    const id = pushReceiptId()
    await pool.query(
      `INSERT INTO push_receipts (id, workspace_id, user_id, scope, subscription_id, retain_until)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, wid, userId(), PUSH_RECEIPT_SCOPES.TEST, pushSubscriptionId(), retainUntil]
    )
    return id
  }

  async function existing(table: string, ids: string[]) {
    const result = await pool.query<{ id: string }>(`SELECT id FROM ${table} WHERE id = ANY($1::text[]) ORDER BY id`, [
      ids,
    ])
    return result.rows.map((row) => row.id)
  }

  test("should delete the endpoint's subscriptions of one identity in each of its workspaces and nothing else", async () => {
    const endpoint = `https://push.example/${randomBytes(6).toString("hex")}`
    const identity = `identity-${randomBytes(6).toString("hex")}`
    const memberA = await addTestMember(pool, wsA, identity)
    const memberB = await addTestMember(pool, wsB, identity)
    const otherIdentity = await addTestMember(pool, wsA, `other-${randomBytes(6).toString("hex")}`)
    const inA = await subscribe(wsA, memberA.id, endpoint)
    const inB = await subscribe(wsB, memberB.id, endpoint)
    const otherEndpoint = await subscribe(wsA, memberA.id, `${endpoint}/other`)
    const otherUser = await subscribe(wsA, otherIdentity.id, endpoint)
    const foreignCopy = await subscribe(wsB, memberA.id, endpoint)

    const service = new PushService({
      pool,
      telemetry: new PushTelemetry({ reporter: new DisabledAnalyticsReporter() }),
      vapidConfig: null,
      lookups: {} as ConstructorParameters<typeof PushService>[0]["lookups"],
    })

    const deleted = await service.unsubscribeAllWorkspaces(endpoint, identity)

    expect({
      deleted,
      remaining: await existing("push_subscriptions", [inA.id, inB.id, otherEndpoint.id, otherUser.id, foreignCopy.id]),
    }).toEqual({ deleted: 2, remaining: [otherEndpoint.id, otherUser.id, foreignCopy.id].sort() })
  })

  test("should delete expired delivery plans of every workspace with their own devices and keep a device another workspace holds for the plan id", async () => {
    const expiresAt = new Date(Date.now() - 8 * DAY_MS)
    const expiredA = await seedPlan(wsA, expiresAt)
    const expiredB = await seedPlan(wsB, expiresAt)
    const live = await seedPlan(wsA, new Date(Date.now() + DAY_MS))
    const deviceA = await seedDevice(wsA, expiredA)
    const deviceB = await seedDevice(wsB, expiredB)
    const deviceLive = await seedDevice(wsA, live)
    const foreignDevice = await seedDevice(wsB, expiredA)

    for (;;) {
      const deleted = await PushDeliveryRepository.deleteExpiredPlans(pool, {
        expiredBefore: new Date(Date.now() - 7 * DAY_MS),
        limit: 500,
      })
      if (deleted === 0) break
    }

    expect({
      plans: await existing("push_delivery_plans", [expiredA, expiredB, live]),
      devices: await existing("push_deliveries", [deviceA, deviceB, deviceLive, foreignDevice]),
    }).toEqual({ plans: [live], devices: [deviceLive, foreignDevice].sort() })
  })

  test("should delete expired receipts of every workspace and keep unexpired ones", async () => {
    const expiredA = await seedReceipt(wsA, new Date(Date.now() - DAY_MS))
    const expiredB = await seedReceipt(wsB, new Date(Date.now() - DAY_MS))
    const live = await seedReceipt(wsA, new Date(Date.now() + DAY_MS))

    for (;;) {
      const deleted = await PushReceiptRepository.deleteExpired(pool, { limit: 500 })
      if (deleted === 0) break
    }

    expect(await existing("push_receipts", [expiredA, expiredB, live])).toEqual([live])
  })
})
