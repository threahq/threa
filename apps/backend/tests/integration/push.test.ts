import { describe, test, expect, beforeAll, afterAll, beforeEach, spyOn } from "bun:test"
import type { Pool } from "pg"
import webpush from "web-push"
import { randomBytes } from "node:crypto"
import {
  PushSubscriptionRepository,
  PushService,
  UserSessionRepository,
  PushTelemetry,
  type PushPreferences,
} from "../../src/features/push"
import { DisabledAnalyticsReporter, type AnalyticsEvent, type AnalyticsReporter } from "@threahq/backend-common"
import { logger } from "../../src/lib/logger"
import { workspaceId, userId, streamId, messageId, activityId } from "../../src/lib/id"
import { setupTestDatabase } from "./setup"
import { drainDuePushJobs } from "./push-queue-helpers"
import {
  PrefNotificationLevels,
  ActivityTypes,
  StreamTypes,
  DEFAULT_PUSH_ACTIONS,
  DEFAULT_PUSH_REMINDER_MINUTES,
  DEFAULT_PUSH_QUICK_REACTION,
  type PrefNotificationLevel,
  type StreamType,
} from "@threahq/types"
import type { ActivityCreatedOutboxPayload } from "../../src/lib/outbox"

function pushPreferences(notificationLevel: PrefNotificationLevel): PushPreferences {
  return {
    notificationLevel,
    pushActions: [...DEFAULT_PUSH_ACTIONS],
    pushReminderMinutes: DEFAULT_PUSH_REMINDER_MINUTES,
    pushQuickReaction: DEFAULT_PUSH_QUICK_REACTION,
  }
}

class RecordingReporter implements AnalyticsReporter {
  events: AnalyticsEvent[] = []
  captureException(): void {}
  captureEvent(event: AnalyticsEvent): void {
    this.events.push(event)
  }
  async shutdown(): Promise<void> {}
}

/** A browser-shaped registration: p256dh is an uncompressed P-256 point, auth 16 random bytes. */
function registrationKeys(): { p256dh: string; auth: string } {
  return { p256dh: webpush.generateVAPIDKeys().publicKey, auth: randomBytes(16).toString("base64url") }
}

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
    await pool.query("DELETE FROM push_deliveries")
    await pool.query("DELETE FROM push_delivery_plans")
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

    test("deleteByIdsAtGeneration removes only rows still at the pinned generation; no-op for empty array", async () => {
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
      const rekeyed = await PushSubscriptionRepository.insert(pool, {
        workspaceId: testWorkspaceId,
        userId: testUserId,
        endpoint: "https://push.example.com/sub/batch-2",
        p256dh: "p2-new",
        auth: "a2",
        deviceKey: "d2",
      })

      expect(await PushSubscriptionRepository.deleteByIdsAtGeneration(pool, testWorkspaceId, [])).toEqual([])
      const deleted = await PushSubscriptionRepository.deleteByIdsAtGeneration(pool, testWorkspaceId, [
        { id: sub1.id, generation: sub1.generation },
        { id: sub2.id, generation: sub2.generation },
      ])

      expect(deleted).toEqual([sub1.id])
      const remaining = await PushSubscriptionRepository.findByUserId(pool, testWorkspaceId, testUserId)
      expect(remaining.map((s) => ({ id: s.id, generation: s.generation }))).toEqual([
        { id: rekeyed.id, generation: sub2.generation + 1 },
      ])
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
        telemetry: new PushTelemetry({ reporter: new DisabledAnalyticsReporter() }),
        vapidConfig: {
          publicKey: "BM1RQ2UEVpAlbEgYOQ3bDrGAOrJGBmmh4_4UkmtGRzhi-5WPFmPuJbA6zv4kCp0iycvTaH6eveCXedCE0xSnZbk",
          privateKey: "eHUfakWGHrS4ft0HiSGyhTOBCQJ9VAKWl4XK53qsjMg",
          subject: "mailto:test@threa.app",
        },
        lookups: {
          getUserPushPreferences: async () => pushPreferences(PrefNotificationLevels.ALL),
          isNotificationPaused: async () => false,
          getStreamType: async () => StreamTypes.CHANNEL,
          getWorkosUserId: async () => null,
          resolveActivityPush: async () => ({ valid: false, reason: "gone" }),
          resolveFiredReminder: async () => null,
          isRewrapOutstanding: async () => false,
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

  describe("PushService activity push (planned, then sent by the push.deliver worker)", () => {
    /** Current activity rows by id, standing in for the activity feature's fresh-source lookup. */
    const plannedActivities = new Map<string, ActivityCreatedOutboxPayload["activity"]>()
    let nextEventId = 1n

    async function deliver(service: PushService, payload: ActivityCreatedOutboxPayload) {
      plannedActivities.set(payload.activity.id, payload.activity)
      await service.planActivityPush({ id: nextEventId++, createdAt: new Date() }, payload)
      await drainDuePushJobs(pool, service, testWorkspaceId)
    }

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
      telemetry?: PushTelemetry
    }) {
      return new PushService({
        pool,
        telemetry: overrides?.telemetry ?? new PushTelemetry({ reporter: new DisabledAnalyticsReporter() }),
        vapidConfig: {
          publicKey: "BM1RQ2UEVpAlbEgYOQ3bDrGAOrJGBmmh4_4UkmtGRzhi-5WPFmPuJbA6zv4kCp0iycvTaH6eveCXedCE0xSnZbk",
          privateKey: "eHUfakWGHrS4ft0HiSGyhTOBCQJ9VAKWl4XK53qsjMg",
          subject: "mailto:test@threa.app",
        },
        lookups: {
          getUserPushPreferences: async () =>
            pushPreferences(overrides?.notificationLevel ?? PrefNotificationLevels.ALL),
          isNotificationPaused: async () => overrides?.notificationPaused ?? false,
          getStreamType: async (_workspaceId) => overrides?.streamType ?? StreamTypes.CHANNEL,
          getWorkosUserId: async () => overrides?.workosUserId ?? null,
          resolveActivityPush: async ({ activityId, plannedStreamId }) => {
            const activity = plannedActivities.get(activityId)
            if (!activity) return { valid: false, reason: "gone" }
            const context = activity.context as Record<string, string | undefined>
            return {
              valid: true,
              source: {
                activityId,
                activityType: activity.activityType,
                streamId: plannedStreamId,
                messageId: activity.messageId,
                contentMarkdown: context.contentPreview ?? null,
                encrypted: false,
                streamName: context.streamName ?? null,
                authorName: context.authorName ?? null,
                authorAvatarUrl: context.authorAvatarUrl,
                emoji: context.emoji ?? null,
                mode: context.mode ?? null,
              },
            }
          },
          resolveFiredReminder: async () => null,
          isRewrapOutstanding: async () => false,
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
        ...registrationKeys(),
        deviceKey: "d",
      })

      await deliver(service, makePayload())
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
        ...registrationKeys(),
        deviceKey: "d",
      })

      await deliver(
        service,
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
        ...registrationKeys(),
        deviceKey: "d",
      })
      await createRecentInactiveSession(testWorkspaceId, testUserId)

      await deliver(
        service,
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
        ...registrationKeys(),
        deviceKey: "d",
      })
      await createRecentInactiveSession(testWorkspaceId, testUserId)

      await deliver(
        service,
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
        ...registrationKeys(),
        deviceKey: "d",
      })
      await createRecentInactiveSession(testWorkspaceId, testUserId)

      await deliver(
        service,
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
        ...registrationKeys(),
        deviceKey: "d",
      })
      await createRecentInactiveSession(testWorkspaceId, testUserId)

      await deliver(service, makePayload())

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
        ...registrationKeys(),
        deviceKey: "d",
      })
      await createRecentInactiveSession(testWorkspaceId, testUserId)

      await deliver(service, makePayload())

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
        ...registrationKeys(),
        deviceKey: "d",
      })
      await createRecentInactiveSession(testWorkspaceId, testUserId)

      await deliver(
        service,
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
        ...registrationKeys(),
        deviceKey: "device-1",
      })
      await PushSubscriptionRepository.insert(pool, {
        workspaceId: testWorkspaceId,
        userId: testUserId,
        endpoint: "https://push.example.com/sub/device-2",
        ...registrationKeys(),
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

      await deliver(service, makePayload())

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
        ...registrationKeys(),
        deviceKey: "device-1",
      })
      await PushSubscriptionRepository.insert(pool, {
        workspaceId: testWorkspaceId,
        userId: testUserId,
        endpoint: "https://push.example.com/sub/device-2",
        ...registrationKeys(),
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

      await deliver(service, makePayload())

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
        ...registrationKeys(),
        deviceKey: "device-1",
      })
      await PushSubscriptionRepository.insert(pool, {
        workspaceId: testWorkspaceId,
        userId: testUserId,
        endpoint: "https://push.example.com/sub/device-2",
        ...registrationKeys(),
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

      await deliver(service, makePayload())

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
        ...registrationKeys(),
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

      await deliver(service, makePayload())

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
        ...registrationKeys(),
        deviceKey: "device-1",
      })
      await PushSubscriptionRepository.insert(pool, {
        workspaceId: testWorkspaceId,
        userId: testUserId,
        endpoint: "https://push.example.com/sub/device-2",
        ...registrationKeys(),
        deviceKey: "device-2",
      })

      // Both devices have sessions that are stale for the 60s active window
      // but still within the 30-day expiry window — not expired
      await createRecentInactiveSession(testWorkspaceId, testUserId, "device-1")
      await createRecentInactiveSession(testWorkspaceId, testUserId, "device-2")

      await deliver(service, makePayload())

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
        ...registrationKeys(),
        deviceKey: "device-1",
      })
      await PushSubscriptionRepository.insert(pool, {
        workspaceId: testWorkspaceId,
        userId: testUserId,
        endpoint: "https://push.example.com/sub/device-2",
        ...registrationKeys(),
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

      await deliver(service, makePayload())

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
        ...registrationKeys(),
        deviceKey: "device-1",
      })
      await PushSubscriptionRepository.insert(pool, {
        workspaceId: testWorkspaceId,
        userId: testUserId,
        endpoint: "https://push.example.com/sub/expired-2",
        ...registrationKeys(),
        deviceKey: "device-2",
      })
      // No socket session AND no recent re-registration → genuinely expired.
      await backdateSubscriptionRegistration("https://push.example.com/sub/expired-1", "60 days")
      await backdateSubscriptionRegistration("https://push.example.com/sub/expired-2", "60 days")

      await deliver(service, makePayload())

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
        ...registrationKeys(),
        deviceKey: "device-1",
      })
      await PushSubscriptionRepository.insert(pool, {
        workspaceId: testWorkspaceId,
        userId: testUserId,
        endpoint: "https://push.example.com/sub/expired-device",
        ...registrationKeys(),
        deviceKey: "device-2",
      })

      // Only device-1 has a recent session (within 30-day expiry window)
      await createRecentInactiveSession(testWorkspaceId, testUserId, "device-1")
      // device-2 has neither a session nor a recent re-registration → expired.
      await backdateSubscriptionRegistration("https://push.example.com/sub/expired-device", "60 days")

      await deliver(service, makePayload())

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
        ...registrationKeys(),
        deviceKey: "device-1",
      })

      // Create a session that's recent (within 30-day expiry window)
      await UserSessionRepository.upsert(pool, {
        workspaceId: testWorkspaceId,
        userId: testUserId,
        deviceKey: "device-1",
        focused: true,
      })

      await deliver(service, makePayload())

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
        ...registrationKeys(),
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

      await deliver(service, makePayload())

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
        ...registrationKeys(),
        deviceKey: "device-http-only",
      })

      await deliver(service, makePayload())

      // Normal push (not session_expired), and the subscription is retained.
      expect(sendSpy).toHaveBeenCalledTimes(1)
      const payload = JSON.parse(sendSpy.mock.calls[0][1] as string)
      expect(payload.data.action).toBeUndefined()
      expect(payload.data.activityType).toBe(ActivityTypes.MENTION)
      const remaining = await PushSubscriptionRepository.findByUserId(pool, testWorkspaceId, testUserId)
      expect(remaining).toHaveLength(1)
    })

    test("should not log endpoint, identifiers or the raw error when a send fails", async () => {
      const service = createServiceWithLookups()
      const sub = await PushSubscriptionRepository.insert(pool, {
        workspaceId: testWorkspaceId,
        userId: testUserId,
        endpoint: "https://fcm.googleapis.com/fcm/send/endpoint-secret-token",
        ...registrationKeys(),
        deviceKey: "d",
      })
      await createRecentInactiveSession(testWorkspaceId, testUserId)
      sendSpy.mockRejectedValueOnce(
        Object.assign(new Error("Received unexpected response code"), {
          statusCode: 500,
          endpoint: sub.endpoint,
          body: "provider-body-secret",
          headers: { "x-secret": "header-secret" },
        })
      )
      const spies = (["debug", "info", "warn", "error"] as const).map((level) =>
        spyOn(logger, level).mockImplementation(() => {})
      )
      try {
        const payload = makePayload()
        await deliver(service, payload)

        const logged = JSON.stringify(spies.flatMap((spy) => spy.mock.calls))
        expect(logged).toContain("unreachable")
        for (const secret of [
          "endpoint-secret-token",
          "provider-body-secret",
          "header-secret",
          testWorkspaceId,
          testUserId,
          sub.id,
          payload.activity.streamId!,
          payload.activity.messageId!,
          "Hello",
        ]) {
          expect(logged).not.toContain(secret)
        }
      } finally {
        for (const spy of spies) spy.mockRestore()
      }
    })

    test("should report the suppression reason as an aggregate event when the user paused notifications", async () => {
      const reporter = new RecordingReporter()
      const telemetry = new PushTelemetry({ reporter })
      const service = createServiceWithLookups({ notificationPaused: true, telemetry })
      await PushSubscriptionRepository.insert(pool, {
        workspaceId: testWorkspaceId,
        userId: testUserId,
        endpoint: "https://push.example.com/sub/paused",
        ...registrationKeys(),
        deviceKey: "d",
      })

      await deliver(service, makePayload())
      telemetry.flush()

      expect(sendSpy).not.toHaveBeenCalled()
      expect(reporter.events).toEqual([
        {
          distinctId: "service:push",
          event: "push_suppressed",
          properties: {
            kind: "activity",
            reason: "paused",
            count: 1,
            window_seconds: expect.any(Number),
            $process_person_profile: false,
          },
        },
      ])
    })

    test("stale subscription cleanup on 410 response", async () => {
      const service = createServiceWithLookups()

      const staleSub = await PushSubscriptionRepository.insert(pool, {
        workspaceId: testWorkspaceId,
        userId: testUserId,
        endpoint: "https://push.example.com/sub/stale-410",
        ...registrationKeys(),
        deviceKey: "d",
      })

      // Need a recent session so the push follows the normal delivery path (not session_expired)
      await createRecentInactiveSession(testWorkspaceId, testUserId)

      // Simulate 410 Gone from push service
      sendSpy.mockRejectedValueOnce(Object.assign(new Error("Gone"), { statusCode: 410 }))

      await deliver(service, makePayload())

      // The stale subscription should be deleted
      const remaining = await PushSubscriptionRepository.findByUserId(pool, testWorkspaceId, testUserId)
      expect(remaining).toHaveLength(0)
    })
  })

  describe("PushService.deliverTestPush", () => {
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
          getUserPushPreferences: async () => pushPreferences(PrefNotificationLevels.ALL),
          isNotificationPaused: async () => false,
          getStreamType: async () => StreamTypes.CHANNEL,
          getWorkosUserId: async () => null,
          resolveActivityPush: async () => ({ valid: false, reason: "gone" }),
          resolveFiredReminder: async () => null,
          isRewrapOutstanding: async () => false,
        },
      })
    }

    test("returns zero attempted when user has no subscriptions", async () => {
      const service = createService()
      const result = await service.deliverTestPush(testWorkspaceId, testUserId)
      expect(result).toEqual({
        testId: expect.stringMatching(/^push_del_/),
        attempted: 0,
        accepted: 0,
        failed: 0,
        delivered: 0,
        devices: [],
      })
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
        ...registrationKeys(),
        deviceKey: "d1",
      })
      await PushSubscriptionRepository.insert(pool, {
        workspaceId: testWorkspaceId,
        userId: testUserId,
        endpoint: "https://push.example.com/sub/test-2",
        ...registrationKeys(),
        deviceKey: "d2",
      })

      const result = await service.deliverTestPush(testWorkspaceId, testUserId)

      expect(result).toMatchObject({ attempted: 2, accepted: 2, failed: 0, delivered: 2 })
      expect(sendSpy).toHaveBeenCalledTimes(2)
      const payload = JSON.parse(sendSpy.mock.calls[0]![1] as string)
      expect(payload.data.kind).toBe("test")
      expect(payload.data.workspaceId).toBe(testWorkspaceId)
    })

    test("should report each device's push-service outcome, keeping attempted/failed/delivered for cached clients", async () => {
      const service = createService()
      const insertSub = (name: string) =>
        PushSubscriptionRepository.insert(pool, {
          workspaceId: testWorkspaceId,
          userId: testUserId,
          endpoint: `https://push.example.com/sub/${name}`,
          ...registrationKeys(),
          deviceKey: `d-${name}`,
          userAgent: `agent-${name}`,
        })
      const liveSub = await insertSub("live")
      const goneSub = await insertSub("gone")
      const downSub = await insertSub("down")

      sendSpy.mockImplementation(async (sub: any) => {
        if (sub.endpoint.endsWith("/gone")) throw Object.assign(new Error("Gone"), { statusCode: 410 })
        if (sub.endpoint.endsWith("/down")) throw Object.assign(new Error("Unavailable"), { statusCode: 503 })
        return { statusCode: 201, body: "", headers: {} } as any
      })

      const result = await service.deliverTestPush(testWorkspaceId, testUserId)

      expect({
        ...result,
        devices: [...result.devices].sort((a, b) => a.deviceKey.localeCompare(b.deviceKey)),
      }).toEqual({
        testId: expect.stringMatching(/^push_del_/),
        attempted: 3,
        accepted: 1,
        failed: 2,
        delivered: 1,
        devices: [
          {
            subscriptionId: downSub.id,
            deviceKey: "d-down",
            userAgent: "agent-down",
            outcome: "unreachable",
            statusCode: 503,
          },
          {
            subscriptionId: goneSub.id,
            deviceKey: "d-gone",
            userAgent: "agent-gone",
            outcome: "registration_gone",
            statusCode: 410,
          },
          {
            subscriptionId: liveSub.id,
            deviceKey: "d-live",
            userAgent: "agent-live",
            outcome: "accepted",
            statusCode: 201,
          },
        ],
      })
      const remaining = await PushSubscriptionRepository.findByUserId(pool, testWorkspaceId, testUserId)
      expect(remaining.map((s) => s.id).sort()).toEqual([downSub.id, liveSub.id].sort())
    })

    test("throws when push is not enabled on the server", async () => {
      const service = new PushService({
        pool,
        telemetry: new PushTelemetry({ reporter: new DisabledAnalyticsReporter() }),
        vapidConfig: null,
        lookups: {
          getUserPushPreferences: async () => pushPreferences(PrefNotificationLevels.ALL),
          isNotificationPaused: async () => false,
          getStreamType: async () => StreamTypes.CHANNEL,
          getWorkosUserId: async () => null,
          resolveActivityPush: async () => ({ valid: false, reason: "gone" }),
          resolveFiredReminder: async () => null,
          isRewrapOutstanding: async () => false,
        },
      })
      await expect(service.deliverTestPush(testWorkspaceId, testUserId)).rejects.toThrow(/not enabled/i)
    })
  })
})
