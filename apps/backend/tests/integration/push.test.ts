import { describe, test, expect, beforeAll, afterAll, beforeEach, spyOn } from "bun:test"
import type { Pool } from "pg"
import webpush from "web-push"
import { PushSubscriptionRepository, PushService, UserSessionRepository } from "../../src/features/push"
import { workspaceId, userId, streamId, messageId, activityId } from "../../src/lib/id"
import { setupTestDatabase } from "./setup"
import {
  PrefNotificationLevels,
  ActivityTypes,
  StreamTypes,
  type PrefNotificationLevel,
  type StreamType,
} from "@threa/types"
import type { ActivityCreatedOutboxPayload } from "../../src/lib/outbox"

// Stub web-push to avoid real HTTP calls
const sendSpy = spyOn(webpush, "sendNotification").mockResolvedValue({} as any)

describe("Push Notifications", () => {
  let pool: Pool
  let testWorkspaceId: string
  let testUserId: string

  beforeAll(async () => {
    pool = await setupTestDatabase()
  })

  afterAll(async () => {
    await pool.end()
  })

  beforeEach(async () => {
    await pool.query("DELETE FROM push_subscriptions")
    await pool.query("DELETE FROM user_sessions")
    testWorkspaceId = workspaceId()
    testUserId = userId()
    sendSpy.mockReset()
    sendSpy.mockResolvedValue({} as any)
  })

  describe("PushSubscriptionRepository", () => {
    test("insert creates subscription with correct fields", async () => {
      const sub = await PushSubscriptionRepository.insert(pool, {
        workspaceId: testWorkspaceId,
        userId: testUserId,
        endpoint: "https://push.example.com/sub/1",
        p256dh: "test-p256dh-key",
        auth: "test-auth-key",
        deviceKey: "device-abc",
        userAgent: "TestBrowser/1.0",
      })

      expect(sub).toMatchObject({
        workspaceId: testWorkspaceId,
        userId: testUserId,
        endpoint: "https://push.example.com/sub/1",
        p256dh: "test-p256dh-key",
        auth: "test-auth-key",
        deviceKey: "device-abc",
        userAgent: "TestBrowser/1.0",
      })
      expect(sub.id).toStartWith("push_sub_")
      expect(sub.createdAt).toBeInstanceOf(Date)
      expect(sub.updatedAt).toBeInstanceOf(Date)
    })

    test("insert upserts keys when same (workspace, user, endpoint)", async () => {
      const params = {
        workspaceId: testWorkspaceId,
        userId: testUserId,
        endpoint: "https://push.example.com/sub/upsert",
        p256dh: "original-p256dh",
        auth: "original-auth",
        deviceKey: "device-xyz",
      }

      const first = await PushSubscriptionRepository.insert(pool, params)

      const second = await PushSubscriptionRepository.insert(pool, {
        ...params,
        p256dh: "updated-p256dh",
        auth: "updated-auth",
      })

      // Same subscription row, not a new one
      expect(second.id).toBe(first.id)
      expect(second.p256dh).toBe("updated-p256dh")
      expect(second.auth).toBe("updated-auth")

      // Verify only one row exists
      const all = await PushSubscriptionRepository.findByUserId(pool, testWorkspaceId, testUserId)
      expect(all).toHaveLength(1)
    })

    test("re-registering an endpoint refreshes updated_at (its last-seen signal)", async () => {
      const params = {
        workspaceId: testWorkspaceId,
        userId: testUserId,
        endpoint: "https://push.example.com/sub/last-seen",
        p256dh: "p",
        auth: "a",
        deviceKey: "d",
      }
      const first = await PushSubscriptionRepository.insert(pool, params)
      expect(first.updatedAt).toBeInstanceOf(Date)

      // Backdate so we can prove the re-register moves it forward. Capture the
      // backdated DB timestamp and assert against *that* — comparing against the
      // original insert (also a near-now() value) races on the millisecond when
      // both inserts land in the same ms, which getTime() then reports as equal.
      const backdated = await pool.query<{ updated_at: Date }>(
        `UPDATE push_subscriptions SET updated_at = now() - interval '40 days' WHERE id = $1 RETURNING updated_at`,
        [first.id]
      )
      const backdatedAt = backdated.rows[0].updated_at

      const second = await PushSubscriptionRepository.insert(pool, params)
      expect(second.id).toBe(first.id)
      // Both DB-clock timestamps: the re-register bumps updated_at to a fresh
      // now(), well past the 40-day-old backdated value.
      expect(second.updatedAt.getTime()).toBeGreaterThan(backdatedAt.getTime())
    })

    test("deleteByEndpoint removes subscription and returns true; false for non-existent", async () => {
      await PushSubscriptionRepository.insert(pool, {
        workspaceId: testWorkspaceId,
        userId: testUserId,
        endpoint: "https://push.example.com/sub/to-delete",
        p256dh: "p",
        auth: "a",
        deviceKey: "d",
      })

      const deleted = await PushSubscriptionRepository.deleteByEndpoint(
        pool,
        testWorkspaceId,
        testUserId,
        "https://push.example.com/sub/to-delete"
      )
      expect(deleted).toBe(true)

      const notFound = await PushSubscriptionRepository.deleteByEndpoint(
        pool,
        testWorkspaceId,
        testUserId,
        "https://push.example.com/sub/nonexistent"
      )
      expect(notFound).toBe(false)
    })

    test("deleteByIds batch removes subscriptions; no-op for empty array", async () => {
      const sub1 = await PushSubscriptionRepository.insert(pool, {
        workspaceId: testWorkspaceId,
        userId: testUserId,
        endpoint: "https://push.example.com/sub/batch-1",
        p256dh: "p1",
        auth: "a1",
        deviceKey: "d1",
      })
      const sub2 = await PushSubscriptionRepository.insert(pool, {
        workspaceId: testWorkspaceId,
        userId: testUserId,
        endpoint: "https://push.example.com/sub/batch-2",
        p256dh: "p2",
        auth: "a2",
        deviceKey: "d2",
      })

      // No-op for empty array
      await PushSubscriptionRepository.deleteByIds(pool, testWorkspaceId, [])
      let remaining = await PushSubscriptionRepository.findByUserId(pool, testWorkspaceId, testUserId)
      expect(remaining).toHaveLength(2)

      // Delete both
      await PushSubscriptionRepository.deleteByIds(pool, testWorkspaceId, [sub1.id, sub2.id])
      remaining = await PushSubscriptionRepository.findByUserId(pool, testWorkspaceId, testUserId)
      expect(remaining).toHaveLength(0)
    })

    test("findByUserId returns all subs for user; empty for no subs", async () => {
      const otherUserId = userId()

      // No subs yet
      const empty = await PushSubscriptionRepository.findByUserId(pool, testWorkspaceId, testUserId)
      expect(empty).toHaveLength(0)

      // Add two subs for testUserId
      await PushSubscriptionRepository.insert(pool, {
        workspaceId: testWorkspaceId,
        userId: testUserId,
        endpoint: "https://push.example.com/sub/find-1",
        p256dh: "p1",
        auth: "a1",
        deviceKey: "d1",
      })
      await PushSubscriptionRepository.insert(pool, {
        workspaceId: testWorkspaceId,
        userId: testUserId,
        endpoint: "https://push.example.com/sub/find-2",
        p256dh: "p2",
        auth: "a2",
        deviceKey: "d2",
      })

      const subs = await PushSubscriptionRepository.findByUserId(pool, testWorkspaceId, testUserId)
      expect(subs).toHaveLength(2)

      // Other user has no subs
      const otherSubs = await PushSubscriptionRepository.findByUserId(pool, testWorkspaceId, otherUserId)
      expect(otherSubs).toHaveLength(0)
    })
  })

  describe("UserSessionRepository", () => {
    test("upsert creates session with correct fields", async () => {
      const session = await UserSessionRepository.upsert(pool, {
        workspaceId: testWorkspaceId,
        userId: testUserId,
        deviceKey: "device-session-1",
      })

      expect(session).toMatchObject({
        workspaceId: testWorkspaceId,
        userId: testUserId,
        deviceKey: "device-session-1",
      })
      expect(session.id).toStartWith("usess_")
      expect(session.lastActiveAt).toBeInstanceOf(Date)
      expect(session.lastFocusedAt).toBeNull()
      expect(session.createdAt).toBeInstanceOf(Date)
    })

    test("upsert with focused=true sets lastFocusedAt", async () => {
      const session = await UserSessionRepository.upsert(pool, {
        workspaceId: testWorkspaceId,
        userId: testUserId,
        deviceKey: "device-focused-1",
        focused: true,
      })

      expect(session.lastFocusedAt).toBeInstanceOf(Date)

      // Upsert again without focused — lastFocusedAt should be preserved
      const updated = await UserSessionRepository.upsert(pool, {
        workspaceId: testWorkspaceId,
        userId: testUserId,
        deviceKey: "device-focused-1",
        focused: false,
      })

      expect(updated.lastFocusedAt).toBeInstanceOf(Date)
      expect(updated.lastFocusedAt!.getTime()).toBe(session.lastFocusedAt!.getTime())
    })

    test("upsert with interacted=true sets lastInteractionAt; preserved across non-interacting upserts", async () => {
      const session = await UserSessionRepository.upsert(pool, {
        workspaceId: testWorkspaceId,
        userId: testUserId,
        deviceKey: "device-interaction-1",
        interacted: true,
      })

      expect(session.lastInteractionAt).toBeInstanceOf(Date)

      const updated = await UserSessionRepository.upsert(pool, {
        workspaceId: testWorkspaceId,
        userId: testUserId,
        deviceKey: "device-interaction-1",
        interacted: false,
      })

      expect(updated.lastInteractionAt).toBeInstanceOf(Date)
      expect(updated.lastInteractionAt!.getTime()).toBe(session.lastInteractionAt!.getTime())
    })

    test("upsert updates lastActiveAt on conflict", async () => {
      const first = await UserSessionRepository.upsert(pool, {
        workspaceId: testWorkspaceId,
        userId: testUserId,
        deviceKey: "device-session-2",
      })

      // Small delay to ensure timestamps differ
      await new Promise((r) => setTimeout(r, 50))

      const second = await UserSessionRepository.upsert(pool, {
        workspaceId: testWorkspaceId,
        userId: testUserId,
        deviceKey: "device-session-2",
      })

      expect(second.id).toBe(first.id)
      expect(second.lastActiveAt.getTime()).toBeGreaterThanOrEqual(first.lastActiveAt.getTime())
    })

    test("getActiveSessions returns sessions within window, excludes stale ones", async () => {
      // Create an active session (just upserted = now)
      await UserSessionRepository.upsert(pool, {
        workspaceId: testWorkspaceId,
        userId: testUserId,
        deviceKey: "active-device",
      })

      // Create a stale session by manually backdating last_active_at
      const staleSession = await UserSessionRepository.upsert(pool, {
        workspaceId: testWorkspaceId,
        userId: testUserId,
        deviceKey: "stale-device",
      })
      await pool.query(`UPDATE user_sessions SET last_active_at = now() - interval '5 minutes' WHERE id = $1`, [
        staleSession.id,
      ])

      // 60_000ms window should only return the active session
      const active = await UserSessionRepository.getActiveSessions(pool, testWorkspaceId, testUserId, 60_000)

      expect(active).toHaveLength(1)
      expect(active[0].deviceKey).toBe("active-device")
    })

    test("cleanupStale deletes sessions older than threshold, returns count", async () => {
      // Create two sessions
      const s1 = await UserSessionRepository.upsert(pool, {
        workspaceId: testWorkspaceId,
        userId: testUserId,
        deviceKey: "cleanup-1",
      })
      const s2 = await UserSessionRepository.upsert(pool, {
        workspaceId: testWorkspaceId,
        userId: testUserId,
        deviceKey: "cleanup-2",
      })

      // Backdate both to be stale
      await pool.query(`UPDATE user_sessions SET last_active_at = now() - interval '2 hours' WHERE id = ANY($1)`, [
        [s1.id, s2.id],
      ])

      // Create a fresh session that should survive cleanup
      await UserSessionRepository.upsert(pool, {
        workspaceId: testWorkspaceId,
        userId: testUserId,
        deviceKey: "cleanup-fresh",
      })

      // Cleanup sessions older than 1 hour (3_600_000 ms)
      const deletedCount = await UserSessionRepository.cleanupStale(pool, 3_600_000)
      expect(deletedCount).toBe(2)

      // Fresh session should still exist
      const remaining = await UserSessionRepository.getActiveSessions(pool, testWorkspaceId, testUserId, 60_000)
      expect(remaining).toHaveLength(1)
      expect(remaining[0].deviceKey).toBe("cleanup-fresh")
    })
  })

  describe("PushService.subscribe (cap enforcement)", () => {
    function createService() {
      return new PushService({
        pool,
        vapidConfig: {
          publicKey: "BM1RQ2UEVpAlbEgYOQ3bDrGAOrJGBmmh4_4UkmtGRzhi-5WPFmPuJbA6zv4kCp0iycvTaH6eveCXedCE0xSnZbk",
          privateKey: "eHUfakWGHrS4ft0HiSGyhTOBCQJ9VAKWl4XK53qsjMg",
          subject: "mailto:test@threa.app",
        },
        lookups: {
          getUserNotificationLevel: async () => PrefNotificationLevels.ALL,
          isNotificationPaused: async () => false,
          getStreamType: async () => StreamTypes.CHANNEL,
          getWorkosUserId: async () => null,
        },
      })
    }

    test("evicts oldest subscription when at cap", async () => {
      const service = createService()

      // Fill to cap (10 subscriptions)
      for (let i = 0; i < 10; i++) {
        await service.subscribe({
          workspaceId: testWorkspaceId,
          userId: testUserId,
          endpoint: `https://push.example.com/sub/cap-${i}`,
          p256dh: `p${i}`,
          auth: `a${i}`,
          deviceKey: `d${i}`,
        })
      }

      // Mark the first subscription as oldest
      const allBefore = await PushSubscriptionRepository.findByUserId(pool, testWorkspaceId, testUserId)
      expect(allBefore).toHaveLength(10)
      const oldestId = allBefore[allBefore.length - 1].id // findByUserId orders DESC by created_at
      await pool.query(`UPDATE push_subscriptions SET updated_at = now() - interval '1 hour' WHERE id = $1`, [oldestId])

      // Subscribe with a new endpoint — should evict the oldest
      const newSub = await service.subscribe({
        workspaceId: testWorkspaceId,
        userId: testUserId,
        endpoint: "https://push.example.com/sub/cap-new",
        p256dh: "pNew",
        auth: "aNew",
        deviceKey: "dNew",
      })

      const allAfter = await PushSubscriptionRepository.findByUserId(pool, testWorkspaceId, testUserId)
      expect(allAfter).toHaveLength(10)
      expect(allAfter.map((s) => s.id)).toContain(newSub.id)
      expect(allAfter.map((s) => s.id)).not.toContain(oldestId)
    })

    test("re-register at cap does not evict", async () => {
      const service = createService()

      // Fill to cap
      for (let i = 0; i < 10; i++) {
        await service.subscribe({
          workspaceId: testWorkspaceId,
          userId: testUserId,
          endpoint: `https://push.example.com/sub/reregister-${i}`,
          p256dh: `p${i}`,
          auth: `a${i}`,
          deviceKey: `d${i}`,
        })
      }

      const allBefore = await PushSubscriptionRepository.findByUserId(pool, testWorkspaceId, testUserId)
      expect(allBefore).toHaveLength(10)
      const beforeIds = allBefore.map((s) => s.id).sort()

      // Re-register an existing endpoint with updated keys — should upsert, not evict
      await service.subscribe({
        workspaceId: testWorkspaceId,
        userId: testUserId,
        endpoint: "https://push.example.com/sub/reregister-0",
        p256dh: "updated-p256dh",
        auth: "updated-auth",
        deviceKey: "d0",
      })

      const allAfter = await PushSubscriptionRepository.findByUserId(pool, testWorkspaceId, testUserId)
      expect(allAfter).toHaveLength(10)
      // Same subscription IDs — no eviction happened
      expect(allAfter.map((s) => s.id).sort()).toEqual(beforeIds)
      // Keys were updated
      const updated = allAfter.find((s) => s.endpoint === "https://push.example.com/sub/reregister-0")
      expect(updated).toMatchObject({ p256dh: "updated-p256dh", auth: "updated-auth" })
    })

    test("below cap adds without eviction", async () => {
      const service = createService()

      const sub1 = await service.subscribe({
        workspaceId: testWorkspaceId,
        userId: testUserId,
        endpoint: "https://push.example.com/sub/below-cap-1",
        p256dh: "p1",
        auth: "a1",
        deviceKey: "d1",
      })

      const sub2 = await service.subscribe({
        workspaceId: testWorkspaceId,
        userId: testUserId,
        endpoint: "https://push.example.com/sub/below-cap-2",
        p256dh: "p2",
        auth: "a2",
        deviceKey: "d2",
      })

      const all = await PushSubscriptionRepository.findByUserId(pool, testWorkspaceId, testUserId)
      expect(all).toHaveLength(2)
      expect(all.map((s) => s.id)).toContain(sub1.id)
      expect(all.map((s) => s.id)).toContain(sub2.id)
    })
  })

  describe("PushService.deliverPushForActivity", () => {
    /** Create a session that's stale for the 60s active window but within the 30-day expiry window. */
    async function createRecentInactiveSession(wId: string, uId: string, deviceKey = "d") {
      const s = await UserSessionRepository.upsert(pool, { workspaceId: wId, userId: uId, deviceKey })
      await pool.query(`UPDATE user_sessions SET last_active_at = now() - interval '2 minutes' WHERE id = $1`, [s.id])
    }

    /**
     * Backdate a subscription's updated_at (its last-registration time) so the
     * "recent re-registration" signal no longer keeps it alive. Lets tests
     * exercise the genuine-expiry path (a subscription must be stale on BOTH
     * the heartbeat and the re-registration signal to be expired).
     */
    async function backdateSubscriptionRegistration(endpoint: string, interval: string) {
      await pool.query(`UPDATE push_subscriptions SET updated_at = now() - $2::interval WHERE endpoint = $1`, [
        endpoint,
        interval,
      ])
    }

    function makePayload(overrides?: Partial<ActivityCreatedOutboxPayload>): ActivityCreatedOutboxPayload {
      return {
        workspaceId: testWorkspaceId,
        targetUserId: testUserId,
        activity: {
          id: activityId(),
          activityType: ActivityTypes.MENTION,
          streamId: streamId(),
          messageId: messageId(),
          actorId: userId(),
          actorType: "user",
          context: { contentPreview: "Hello", streamName: "general" },
          createdAt: new Date().toISOString(),
          isSelf: false,
        },
        ...overrides,
      }
    }

    function createServiceWithLookups(overrides?: {
      notificationLevel?: PrefNotificationLevel
      notificationPaused?: boolean
      streamType?: StreamType | null
      workosUserId?: string | null
    }) {
      return new PushService({
        pool,
        vapidConfig: {
          publicKey: "BM1RQ2UEVpAlbEgYOQ3bDrGAOrJGBmmh4_4UkmtGRzhi-5WPFmPuJbA6zv4kCp0iycvTaH6eveCXedCE0xSnZbk",
          privateKey: "eHUfakWGHrS4ft0HiSGyhTOBCQJ9VAKWl4XK53qsjMg",
          subject: "mailto:test@threa.app",
        },
        lookups: {
          getUserNotificationLevel: async () => overrides?.notificationLevel ?? PrefNotificationLevels.ALL,
          isNotificationPaused: async () => overrides?.notificationPaused ?? false,
          getStreamType: async (_workspaceId) => overrides?.streamType ?? StreamTypes.CHANNEL,
          getWorkosUserId: async () => overrides?.workosUserId ?? null,
        },
      })
    }

    test("pref=none skips push", async () => {
      const service = createServiceWithLookups({ notificationLevel: PrefNotificationLevels.NONE })

      // Create a subscription so we can verify it's NOT called
      await PushSubscriptionRepository.insert(pool, {
        workspaceId: testWorkspaceId,
        userId: testUserId,
        endpoint: "https://push.example.com/sub/pref-none",
        p256dh: "p",
        auth: "a",
        deviceKey: "d",
      })

      await service.deliverPushForActivity(makePayload())
      expect(sendSpy).not.toHaveBeenCalled()
    })

    test("pref=mentions, activityType=message in channel skips", async () => {
      const service = createServiceWithLookups({
        notificationLevel: PrefNotificationLevels.MENTIONS,
        streamType: StreamTypes.CHANNEL,
      })

      await PushSubscriptionRepository.insert(pool, {
        workspaceId: testWorkspaceId,
        userId: testUserId,
        endpoint: "https://push.example.com/sub/mentions-channel",
        p256dh: "p",
        auth: "a",
        deviceKey: "d",
      })

      await service.deliverPushForActivity(
        makePayload({
          activity: {
            ...makePayload().activity,
            activityType: ActivityTypes.MESSAGE,
          },
        })
      )

      expect(sendSpy).not.toHaveBeenCalled()
    })

    test("pref=mentions, activityType=mention pushes", async () => {
      const service = createServiceWithLookups({
        notificationLevel: PrefNotificationLevels.MENTIONS,
      })

      await PushSubscriptionRepository.insert(pool, {
        workspaceId: testWorkspaceId,
        userId: testUserId,
        endpoint: "https://push.example.com/sub/mentions-mention",
        p256dh: "p",
        auth: "a",
        deviceKey: "d",
      })
      await createRecentInactiveSession(testWorkspaceId, testUserId)

      await service.deliverPushForActivity(
        makePayload({
          activity: {
            ...makePayload().activity,
            activityType: ActivityTypes.MENTION,
          },
        })
      )

      expect(sendSpy).toHaveBeenCalledTimes(1)
      expect(sendSpy.mock.calls[0][0]).toMatchObject({
        endpoint: "https://push.example.com/sub/mentions-mention",
      })
    })

    test("pref=mentions, activityType=message in DM pushes", async () => {
      const service = createServiceWithLookups({
        notificationLevel: PrefNotificationLevels.MENTIONS,
        streamType: StreamTypes.DM,
      })

      await PushSubscriptionRepository.insert(pool, {
        workspaceId: testWorkspaceId,
        userId: testUserId,
        endpoint: "https://push.example.com/sub/mentions-dm",
        p256dh: "p",
        auth: "a",
        deviceKey: "d",
      })
      await createRecentInactiveSession(testWorkspaceId, testUserId)

      await service.deliverPushForActivity(
        makePayload({
          activity: {
            ...makePayload().activity,
            activityType: ActivityTypes.MESSAGE,
          },
        })
      )

      expect(sendSpy).toHaveBeenCalledTimes(1)
      expect(sendSpy.mock.calls[0][0]).toMatchObject({
        endpoint: "https://push.example.com/sub/mentions-dm",
      })
    })

    test("pref=all pushes for any activity", async () => {
      const service = createServiceWithLookups({
        notificationLevel: PrefNotificationLevels.ALL,
      })

      await PushSubscriptionRepository.insert(pool, {
        workspaceId: testWorkspaceId,
        userId: testUserId,
        endpoint: "https://push.example.com/sub/all-activity",
        p256dh: "p",
        auth: "a",
        deviceKey: "d",
      })
      await createRecentInactiveSession(testWorkspaceId, testUserId)

      await service.deliverPushForActivity(
        makePayload({
          activity: {
            ...makePayload().activity,
            activityType: ActivityTypes.MESSAGE,
          },
        })
      )

      expect(sendSpy).toHaveBeenCalledTimes(1)
      expect(sendSpy.mock.calls[0][0]).toMatchObject({
        endpoint: "https://push.example.com/sub/all-activity",
      })
    })

    test("activity payload carries the recipient's workosUserId for cross-account routing", async () => {
      const service = createServiceWithLookups({ workosUserId: "user_01HRECIPIENTWORKOS" })

      await PushSubscriptionRepository.insert(pool, {
        workspaceId: testWorkspaceId,
        userId: testUserId,
        endpoint: "https://push.example.com/sub/workos-id",
        p256dh: "p",
        auth: "a",
        deviceKey: "d",
      })
      await createRecentInactiveSession(testWorkspaceId, testUserId)

      await service.deliverPushForActivity(makePayload())

      expect(sendSpy).toHaveBeenCalledTimes(1)
      const payload = JSON.parse(sendSpy.mock.calls[0][1] as string)
      expect(payload.data.workosUserId).toBe("user_01HRECIPIENTWORKOS")
    })

    test("activity payload omits workosUserId when the recipient is unresolvable", async () => {
      const service = createServiceWithLookups({ workosUserId: null })

      await PushSubscriptionRepository.insert(pool, {
        workspaceId: testWorkspaceId,
        userId: testUserId,
        endpoint: "https://push.example.com/sub/no-workos-id",
        p256dh: "p",
        auth: "a",
        deviceKey: "d",
      })
      await createRecentInactiveSession(testWorkspaceId, testUserId)

      await service.deliverPushForActivity(makePayload())

      expect(sendSpy).toHaveBeenCalledTimes(1)
      const payload = JSON.parse(sendSpy.mock.calls[0][1] as string)
      expect(payload.data).not.toHaveProperty("workosUserId")
    })

    test("reaction payload carries the emoji so the SW can render a reaction line", async () => {
      const service = createServiceWithLookups()

      await PushSubscriptionRepository.insert(pool, {
        workspaceId: testWorkspaceId,
        userId: testUserId,
        endpoint: "https://push.example.com/sub/reaction-emoji",
        p256dh: "p",
        auth: "a",
        deviceKey: "d",
      })
      await createRecentInactiveSession(testWorkspaceId, testUserId)

      await service.deliverPushForActivity(
        makePayload({
          activity: {
            ...makePayload().activity,
            activityType: ActivityTypes.REACTION,
            context: { contentPreview: "ship it", streamName: "general", authorName: "Pierre", emoji: "🫡" },
          },
        })
      )

      expect(sendSpy).toHaveBeenCalledTimes(1)
      const payload = JSON.parse(sendSpy.mock.calls[0][1] as string)
      expect(payload.data).toMatchObject({
        activityType: ActivityTypes.REACTION,
        authorName: "Pierre",
        contentPreview: "ship it",
        emoji: "🫡",
      })
    })

    test("focused device with recent interaction → only pushes to that device", async () => {
      const service = createServiceWithLookups()

      // Two subscriptions on different devices, both with recent sessions
      await PushSubscriptionRepository.insert(pool, {
        workspaceId: testWorkspaceId,
        userId: testUserId,
        endpoint: "https://push.example.com/sub/device-1",
        p256dh: "p1",
        auth: "a1",
        deviceKey: "device-1",
      })
      await PushSubscriptionRepository.insert(pool, {
        workspaceId: testWorkspaceId,
        userId: testUserId,
        endpoint: "https://push.example.com/sub/device-2",
        p256dh: "p2",
        auth: "a2",
        deviceKey: "device-2",
      })

      // device-2 is live (heartbeat fresh) but unattended — proves attended
      // routing wins over a live-but-idle peer, not just over a stale session.
      await UserSessionRepository.upsert(pool, {
        workspaceId: testWorkspaceId,
        userId: testUserId,
        deviceKey: "device-2",
      })
      // device-1 is the device the user is on: focused and just interacted
      await UserSessionRepository.upsert(pool, {
        workspaceId: testWorkspaceId,
        userId: testUserId,
        deviceKey: "device-1",
        focused: true,
        interacted: true,
      })

      await service.deliverPushForActivity(makePayload())

      // Only device-1 receives push — SW decides whether to display
      expect(sendSpy).toHaveBeenCalledTimes(1)
      expect(sendSpy.mock.calls[0][0]).toMatchObject({
        endpoint: "https://push.example.com/sub/device-1",
      })
    })

    test("focused but idle (no recent interaction) → fans out to all active devices", async () => {
      const service = createServiceWithLookups()

      // Two subscriptions on different devices
      await PushSubscriptionRepository.insert(pool, {
        workspaceId: testWorkspaceId,
        userId: testUserId,
        endpoint: "https://push.example.com/sub/device-1",
        p256dh: "p1",
        auth: "a1",
        deviceKey: "device-1",
      })
      await PushSubscriptionRepository.insert(pool, {
        workspaceId: testWorkspaceId,
        userId: testUserId,
        endpoint: "https://push.example.com/sub/device-2",
        p256dh: "p2",
        auth: "a2",
        deviceKey: "device-2",
      })

      // device-1 is focused but the user hasn't touched it recently
      // (e.g. they walked away leaving Threa focused, or the PWA bug where
      // hasFocus() reports true on a background window). Without an interaction
      // signal we don't trust focus alone.
      await UserSessionRepository.upsert(pool, {
        workspaceId: testWorkspaceId,
        userId: testUserId,
        deviceKey: "device-1",
        focused: true,
      })
      // device-2 is also live (heartbeat recent) but not focused
      await UserSessionRepository.upsert(pool, {
        workspaceId: testWorkspaceId,
        userId: testUserId,
        deviceKey: "device-2",
      })

      await service.deliverPushForActivity(makePayload())

      // No device proves the user is on it → push everywhere so they see it
      // on whichever device they pick up next.
      expect(sendSpy).toHaveBeenCalledTimes(2)
      const calledEndpoints = sendSpy.mock.calls.map((c) => c[0].endpoint).sort()
      expect(calledEndpoints).toEqual([
        "https://push.example.com/sub/device-1",
        "https://push.example.com/sub/device-2",
      ])
    })

    test("interaction goes stale (>2m) → fans out to all active devices", async () => {
      const service = createServiceWithLookups()

      await PushSubscriptionRepository.insert(pool, {
        workspaceId: testWorkspaceId,
        userId: testUserId,
        endpoint: "https://push.example.com/sub/device-1",
        p256dh: "p1",
        auth: "a1",
        deviceKey: "device-1",
      })
      await PushSubscriptionRepository.insert(pool, {
        workspaceId: testWorkspaceId,
        userId: testUserId,
        endpoint: "https://push.example.com/sub/device-2",
        p256dh: "p2",
        auth: "a2",
        deviceKey: "device-2",
      })

      // device-1 was focused and interacted with, but the interaction was 5m ago
      // (user got up to use the toilet and left their laptop focused).
      const s1 = await UserSessionRepository.upsert(pool, {
        workspaceId: testWorkspaceId,
        userId: testUserId,
        deviceKey: "device-1",
        focused: true,
        interacted: true,
      })
      await pool.query(`UPDATE user_sessions SET last_interaction_at = now() - interval '5 minutes' WHERE id = $1`, [
        s1.id,
      ])
      // device-2 is live (heartbeat fresh) but not focused
      await UserSessionRepository.upsert(pool, {
        workspaceId: testWorkspaceId,
        userId: testUserId,
        deviceKey: "device-2",
      })

      await service.deliverPushForActivity(makePayload())

      // Interaction stale → fanout so the user gets it on whichever device they pick up
      expect(sendSpy).toHaveBeenCalledTimes(2)
      const calledEndpoints = sendSpy.mock.calls.map((c) => c[0].endpoint).sort()
      expect(calledEndpoints).toEqual([
        "https://push.example.com/sub/device-1",
        "https://push.example.com/sub/device-2",
      ])
    })

    test("attended device has session but no push subscription → falls back to all active subscriptions", async () => {
      const service = createServiceWithLookups()

      // Subscription on device-1 only
      await PushSubscriptionRepository.insert(pool, {
        workspaceId: testWorkspaceId,
        userId: testUserId,
        endpoint: "https://push.example.com/sub/device-1",
        p256dh: "p1",
        auth: "a1",
        deviceKey: "device-1",
      })

      // device-1 is live (heartbeat fresh) but unattended — confirms the
      // fallback target is a real online device, not a stale-but-non-expired one.
      await UserSessionRepository.upsert(pool, {
        workspaceId: testWorkspaceId,
        userId: testUserId,
        deviceKey: "device-1",
      })

      // The attended device (device-2) has no push subscription registered
      await UserSessionRepository.upsert(pool, {
        workspaceId: testWorkspaceId,
        userId: testUserId,
        deviceKey: "device-2",
        focused: true,
        interacted: true,
      })

      await service.deliverPushForActivity(makePayload())

      // Intersection is empty → falls back to all active subs (only device-1)
      expect(sendSpy).toHaveBeenCalledTimes(1)
      expect(sendSpy.mock.calls[0][0]).toMatchObject({
        endpoint: "https://push.example.com/sub/device-1",
      })
    })

    test("no active sessions but recent session exists → pushes to all devices (not session_expired)", async () => {
      const service = createServiceWithLookups()

      // Two subscriptions, no *active* sessions (within 60s), but a recent session exists
      // (within 7-day expiry window) — user went offline briefly, not logged out
      await PushSubscriptionRepository.insert(pool, {
        workspaceId: testWorkspaceId,
        userId: testUserId,
        endpoint: "https://push.example.com/sub/device-1",
        p256dh: "p1",
        auth: "a1",
        deviceKey: "device-1",
      })
      await PushSubscriptionRepository.insert(pool, {
        workspaceId: testWorkspaceId,
        userId: testUserId,
        endpoint: "https://push.example.com/sub/device-2",
        p256dh: "p2",
        auth: "a2",
        deviceKey: "device-2",
      })

      // Both devices have sessions that are stale for the 60s active window
      // but still within the 30-day expiry window — not expired
      await createRecentInactiveSession(testWorkspaceId, testUserId, "device-1")
      await createRecentInactiveSession(testWorkspaceId, testUserId, "device-2")

      await service.deliverPushForActivity(makePayload())

      // Both devices receive normal push — user is offline but sessions not expired
      expect(sendSpy).toHaveBeenCalledTimes(2)
      const calledEndpoints = sendSpy.mock.calls.map((c) => c[0].endpoint).sort()
      expect(calledEndpoints).toEqual([
        "https://push.example.com/sub/device-1",
        "https://push.example.com/sub/device-2",
      ])
      // Verify it's a normal push, not session_expired
      const payload = JSON.parse(sendSpy.mock.calls[0][1] as string)
      expect(payload.data.action).toBeUndefined()
    })

    test("stale sessions (60s+) → pushes to all devices", async () => {
      const service = createServiceWithLookups()

      await PushSubscriptionRepository.insert(pool, {
        workspaceId: testWorkspaceId,
        userId: testUserId,
        endpoint: "https://push.example.com/sub/device-1",
        p256dh: "p1",
        auth: "a1",
        deviceKey: "device-1",
      })
      await PushSubscriptionRepository.insert(pool, {
        workspaceId: testWorkspaceId,
        userId: testUserId,
        endpoint: "https://push.example.com/sub/device-2",
        p256dh: "p2",
        auth: "a2",
        deviceKey: "device-2",
      })

      // Both devices have sessions, but they're stale (older than 60s)
      const s1 = await UserSessionRepository.upsert(pool, {
        workspaceId: testWorkspaceId,
        userId: testUserId,
        deviceKey: "device-1",
        focused: true,
      })
      const s2 = await UserSessionRepository.upsert(pool, {
        workspaceId: testWorkspaceId,
        userId: testUserId,
        deviceKey: "device-2",
        focused: true,
      })
      await pool.query(
        `UPDATE user_sessions SET last_active_at = now() - interval '5 minutes', last_focused_at = now() - interval '5 minutes' WHERE id = ANY($1)`,
        [[s1.id, s2.id]]
      )

      await service.deliverPushForActivity(makePayload())

      // All sessions stale → user is offline → push to all devices
      expect(sendSpy).toHaveBeenCalledTimes(2)
      const calledEndpoints = sendSpy.mock.calls.map((c) => c[0].endpoint).sort()
      expect(calledEndpoints).toEqual([
        "https://push.example.com/sub/device-1",
        "https://push.example.com/sub/device-2",
      ])
    })

    test("no recent session on any device → sends session_expired to all and cleans up", async () => {
      const service = createServiceWithLookups()

      // Two subscriptions, no sessions at all (user never connected or sessions GC'd)
      await PushSubscriptionRepository.insert(pool, {
        workspaceId: testWorkspaceId,
        userId: testUserId,
        endpoint: "https://push.example.com/sub/expired-1",
        p256dh: "p1",
        auth: "a1",
        deviceKey: "device-1",
      })
      await PushSubscriptionRepository.insert(pool, {
        workspaceId: testWorkspaceId,
        userId: testUserId,
        endpoint: "https://push.example.com/sub/expired-2",
        p256dh: "p2",
        auth: "a2",
        deviceKey: "device-2",
      })
      // No socket session AND no recent re-registration → genuinely expired.
      await backdateSubscriptionRegistration("https://push.example.com/sub/expired-1", "60 days")
      await backdateSubscriptionRegistration("https://push.example.com/sub/expired-2", "60 days")

      await service.deliverPushForActivity(makePayload())

      // Should have sent session_expired push to both devices
      expect(sendSpy).toHaveBeenCalledTimes(2)
      const payloads = sendSpy.mock.calls.map((c) => JSON.parse(c[1] as string))
      expect(payloads[0].data).toMatchObject({ action: "session_expired", workspaceId: testWorkspaceId })
      expect(payloads[1].data).toMatchObject({ action: "session_expired", workspaceId: testWorkspaceId })

      // All subscriptions should be cleaned up
      const remaining = await PushSubscriptionRepository.findByUserId(pool, testWorkspaceId, testUserId)
      expect(remaining).toHaveLength(0)
    })

    test("mixed: one device has recent session, other expired → normal push to active, session_expired to expired", async () => {
      const service = createServiceWithLookups()

      // device-1 has a recent session, device-2 has no session (expired)
      await PushSubscriptionRepository.insert(pool, {
        workspaceId: testWorkspaceId,
        userId: testUserId,
        endpoint: "https://push.example.com/sub/active-device",
        p256dh: "p1",
        auth: "a1",
        deviceKey: "device-1",
      })
      await PushSubscriptionRepository.insert(pool, {
        workspaceId: testWorkspaceId,
        userId: testUserId,
        endpoint: "https://push.example.com/sub/expired-device",
        p256dh: "p2",
        auth: "a2",
        deviceKey: "device-2",
      })

      // Only device-1 has a recent session (within 30-day expiry window)
      await createRecentInactiveSession(testWorkspaceId, testUserId, "device-1")
      // device-2 has neither a session nor a recent re-registration → expired.
      await backdateSubscriptionRegistration("https://push.example.com/sub/expired-device", "60 days")

      await service.deliverPushForActivity(makePayload())

      // Should send 2 pushes: normal to device-1, session_expired to device-2
      expect(sendSpy).toHaveBeenCalledTimes(2)
      const calls = sendSpy.mock.calls.map((c) => ({
        endpoint: (c[0] as { endpoint: string }).endpoint,
        payload: JSON.parse(c[1] as string),
      }))

      const activeCall = calls.find((c) => c.endpoint === "https://push.example.com/sub/active-device")
      const expiredCall = calls.find((c) => c.endpoint === "https://push.example.com/sub/expired-device")

      expect(activeCall).toBeDefined()
      expect(activeCall!.payload.data.action).toBeUndefined()
      expect(activeCall!.payload.data.activityType).toBe(ActivityTypes.MENTION)

      expect(expiredCall).toBeDefined()
      expect(expiredCall!.payload.data).toMatchObject({ action: "session_expired", workspaceId: testWorkspaceId })

      // Only the expired subscription should be cleaned up
      const remaining = await PushSubscriptionRepository.findByUserId(pool, testWorkspaceId, testUserId)
      expect(remaining).toHaveLength(1)
      expect(remaining[0].deviceKey).toBe("device-1")
    })

    test("recent session exists on device → delivers normal push, not session_expired", async () => {
      const service = createServiceWithLookups()

      await PushSubscriptionRepository.insert(pool, {
        workspaceId: testWorkspaceId,
        userId: testUserId,
        endpoint: "https://push.example.com/sub/active-user",
        p256dh: "p",
        auth: "a",
        deviceKey: "device-1",
      })

      // Create a session that's recent (within 30-day expiry window)
      await UserSessionRepository.upsert(pool, {
        workspaceId: testWorkspaceId,
        userId: testUserId,
        deviceKey: "device-1",
        focused: true,
      })

      await service.deliverPushForActivity(makePayload())

      // Should send normal push, not session_expired
      expect(sendSpy).toHaveBeenCalledTimes(1)
      const payload = JSON.parse(sendSpy.mock.calls[0][1] as string)
      expect(payload.data.action).toBeUndefined()
      expect(payload.data.activityType).toBe(ActivityTypes.MENTION)

      // Subscription should still exist
      const subs = await PushSubscriptionRepository.findByUserId(pool, testWorkspaceId, testUserId)
      expect(subs).toHaveLength(1)
    })

    test("cross-workspace: device active in another workspace keeps subscription alive", async () => {
      const service = createServiceWithLookups()
      const otherWorkspaceId = "ws_other_workspace"

      // Subscription in testWorkspaceId, but NO session in this workspace
      await PushSubscriptionRepository.insert(pool, {
        workspaceId: testWorkspaceId,
        userId: testUserId,
        endpoint: "https://push.example.com/sub/cross-ws",
        p256dh: "p",
        auth: "a",
        deviceKey: "device-1",
      })
      // Backdate the local re-registration so ONLY the cross-workspace session
      // can keep this subscription alive — that's what this test asserts.
      await backdateSubscriptionRegistration("https://push.example.com/sub/cross-ws", "60 days")

      // Session exists on the SAME device but in a DIFFERENT workspace.
      // Auth is global (single cookie), so this proves the device is still logged in.
      await UserSessionRepository.upsert(pool, {
        workspaceId: otherWorkspaceId,
        userId: "user_other_workspace_id",
        deviceKey: "device-1",
      })

      await service.deliverPushForActivity(makePayload())

      // Should send normal push — device is still authenticated
      expect(sendSpy).toHaveBeenCalledTimes(1)
      const payload = JSON.parse(sendSpy.mock.calls[0][1] as string)
      expect(payload.data.action).toBeUndefined()
      expect(payload.data.activityType).toBe(ActivityTypes.MENTION)

      // Subscription should still exist
      const subs = await PushSubscriptionRepository.findByUserId(pool, testWorkspaceId, testUserId)
      expect(subs).toHaveLength(1)
    })

    test("recent re-registration with no socket session anywhere → delivers normally (survives backend socket-session timeout)", async () => {
      const service = createServiceWithLookups()

      // Subscription was re-registered recently over HTTP (auto-subscribe on app
      // open), but the device has NO user_sessions row at all — the WebSocket
      // heartbeat never landed (flaky mobile WS, iOS PWA, proxy blocking WS).
      // The old behaviour deleted this subscription as "expired"; it must now
      // survive because the device clearly logged in recently.
      await PushSubscriptionRepository.insert(pool, {
        workspaceId: testWorkspaceId,
        userId: testUserId,
        endpoint: "https://push.example.com/sub/http-only",
        p256dh: "p",
        auth: "a",
        deviceKey: "device-http-only",
      })

      await service.deliverPushForActivity(makePayload())

      // Normal push (not session_expired), and the subscription is retained.
      expect(sendSpy).toHaveBeenCalledTimes(1)
      const payload = JSON.parse(sendSpy.mock.calls[0][1] as string)
      expect(payload.data.action).toBeUndefined()
      expect(payload.data.activityType).toBe(ActivityTypes.MENTION)
      const remaining = await PushSubscriptionRepository.findByUserId(pool, testWorkspaceId, testUserId)
      expect(remaining).toHaveLength(1)
    })

    test("stale subscription cleanup on 410 response", async () => {
      const service = createServiceWithLookups()

      const staleSub = await PushSubscriptionRepository.insert(pool, {
        workspaceId: testWorkspaceId,
        userId: testUserId,
        endpoint: "https://push.example.com/sub/stale-410",
        p256dh: "p",
        auth: "a",
        deviceKey: "d",
      })

      // Need a recent session so the push follows the normal delivery path (not session_expired)
      await createRecentInactiveSession(testWorkspaceId, testUserId)

      // Simulate 410 Gone from push service
      sendSpy.mockRejectedValueOnce(Object.assign(new Error("Gone"), { statusCode: 410 }))

      await service.deliverPushForActivity(makePayload())

      // The stale subscription should be deleted
      const remaining = await PushSubscriptionRepository.findByUserId(pool, testWorkspaceId, testUserId)
      expect(remaining).toHaveLength(0)
    })
  })

  describe("PushService.deliverTestPush", () => {
    function createService() {
      return new PushService({
        pool,
        vapidConfig: {
          publicKey: "BM1RQ2UEVpAlbEgYOQ3bDrGAOrJGBmmh4_4UkmtGRzhi-5WPFmPuJbA6zv4kCp0iycvTaH6eveCXedCE0xSnZbk",
          privateKey: "eHUfakWGHrS4ft0HiSGyhTOBCQJ9VAKWl4XK53qsjMg",
          subject: "mailto:test@threa.app",
        },
        lookups: {
          getUserNotificationLevel: async () => PrefNotificationLevels.ALL,
          isNotificationPaused: async () => false,
          getStreamType: async () => StreamTypes.CHANNEL,
          getWorkosUserId: async () => null,
        },
      })
    }

    test("returns zero attempted when user has no subscriptions", async () => {
      const service = createService()
      const result = await service.deliverTestPush(testWorkspaceId, testUserId)
      expect(result).toEqual({ attempted: 0, failed: 0 })
      expect(sendSpy).not.toHaveBeenCalled()
    })

    test("sends a test payload to every subscription regardless of session state", async () => {
      const service = createService()

      // Two subs, neither device has any session — normal delivery would skip these
      // (session_expired path), but a test push should bypass that gating.
      await PushSubscriptionRepository.insert(pool, {
        workspaceId: testWorkspaceId,
        userId: testUserId,
        endpoint: "https://push.example.com/sub/test-1",
        p256dh: "p",
        auth: "a",
        deviceKey: "d1",
      })
      await PushSubscriptionRepository.insert(pool, {
        workspaceId: testWorkspaceId,
        userId: testUserId,
        endpoint: "https://push.example.com/sub/test-2",
        p256dh: "p",
        auth: "a",
        deviceKey: "d2",
      })

      const result = await service.deliverTestPush(testWorkspaceId, testUserId)

      expect(result).toEqual({ attempted: 2, failed: 0 })
      expect(sendSpy).toHaveBeenCalledTimes(2)
      const payload = JSON.parse(sendSpy.mock.calls[0]![1] as string)
      expect(payload.data.kind).toBe("test")
      expect(payload.data.workspaceId).toBe(testWorkspaceId)
    })

    test("counts failures and evicts subscriptions returning 410 Gone", async () => {
      const service = createService()

      const liveSub = await PushSubscriptionRepository.insert(pool, {
        workspaceId: testWorkspaceId,
        userId: testUserId,
        endpoint: "https://push.example.com/sub/live",
        p256dh: "p",
        auth: "a",
        deviceKey: "d-live",
      })
      await PushSubscriptionRepository.insert(pool, {
        workspaceId: testWorkspaceId,
        userId: testUserId,
        endpoint: "https://push.example.com/sub/stale",
        p256dh: "p",
        auth: "a",
        deviceKey: "d-stale",
      })

      sendSpy.mockImplementation(async (sub: any) => {
        if (sub.endpoint.endsWith("/stale")) {
          throw Object.assign(new Error("Gone"), { statusCode: 410 })
        }
        return {} as any
      })

      const result = await service.deliverTestPush(testWorkspaceId, testUserId)

      expect(result).toEqual({ attempted: 2, failed: 1 })
      const remaining = await PushSubscriptionRepository.findByUserId(pool, testWorkspaceId, testUserId)
      expect(remaining.map((s) => s.id)).toEqual([liveSub.id])
    })

    test("throws when push is not enabled on the server", async () => {
      const service = new PushService({
        pool,
        vapidConfig: null,
        lookups: {
          getUserNotificationLevel: async () => PrefNotificationLevels.ALL,
          isNotificationPaused: async () => false,
          getStreamType: async () => StreamTypes.CHANNEL,
          getWorkosUserId: async () => null,
        },
      })
      await expect(service.deliverTestPush(testWorkspaceId, testUserId)).rejects.toThrow(/not enabled/i)
    })
  })
})
