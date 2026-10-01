import { describe, it, expect, spyOn, beforeEach, afterEach } from "bun:test"
import webpush from "web-push"
import { randomBytes } from "node:crypto"
import type { Pool } from "pg"
import { ActivityTypes, PrefNotificationLevels, type PrefNotificationLevel } from "@threahq/types"
import { DisabledAnalyticsReporter } from "@threahq/backend-common"
import { PushService } from "./service"
import { PushTelemetry } from "./telemetry"
import { PushSubscriptionRepository } from "./repository"
import type { ActivityCreatedOutboxPayload } from "../../lib/outbox"

function makeActivityPayload(): ActivityCreatedOutboxPayload {
  return {
    workspaceId: "ws_1",
    targetUserId: "usr_1",
    counts: { mentionCount: 1, activityCount: 1 },
    activity: {
      id: "act_1",
      activityType: ActivityTypes.MESSAGE,
      streamId: "stream_1",
      messageId: "msg_1",
      actorId: "usr_2",
      actorType: "user",
      context: {},
      createdAt: new Date().toISOString(),
      isSelf: false,
      emoji: null,
    },
  }
}

/** A browser-shaped registration: p256dh is an uncompressed P-256 point, auth 16 random bytes. */
function registrationKeys(): { p256dh: string; auth: string } {
  return { p256dh: webpush.generateVAPIDKeys().publicKey, auth: randomBytes(16).toString("base64url") }
}

const EVENT = { id: 1n, createdAt: new Date() }

const fakePool = {
  connect: async () => ({ query: async () => ({ rows: [] }), release: () => {} }),
} as unknown as Pool

function makeService(
  isNotificationPaused: boolean,
  level: PrefNotificationLevel = PrefNotificationLevels.ALL
): PushService {
  const keys = webpush.generateVAPIDKeys()
  return new PushService({
    pool: fakePool,
    telemetry: new PushTelemetry({ reporter: new DisabledAnalyticsReporter() }),
    vapidConfig: { publicKey: keys.publicKey, privateKey: keys.privateKey, subject: "mailto:test@example.com" },
    lookups: {
      getUserPushPreferences: async () => ({
        notificationLevel: level,
        pushActions: ["mark_read", "remind"],
        pushReminderMinutes: 5,
        pushQuickReaction: "👍",
      }),
      isNotificationPaused: async () => isNotificationPaused,
      getStreamType: async () => "channel",
      getWorkosUserId: async () => "workos_1",
      resolveActivityPush: async () => ({ valid: false, reason: "gone" }),
      resolveFiredReminder: async () => null,
      isRewrapOutstanding: async () => false,
      findAnalyticsConsentGrant: async () => null,
      isE2eRootedStream: async () => false,
    },
  })
}

describe("PushService do-not-disturb gating", () => {
  let findByUserId: ReturnType<typeof spyOn>

  beforeEach(() => {
    findByUserId = spyOn(PushSubscriptionRepository, "findByUserId").mockResolvedValue([])
  })

  afterEach(() => {
    findByUserId.mockRestore()
  })

  it("does not deliver — or even resolve devices — while notifications are paused", async () => {
    await makeService(true).planActivityPush(EVENT, makeActivityPayload())
    expect(findByUserId).not.toHaveBeenCalled()
  })

  it("suppresses the ring push while notifications are paused (the socket ring still fires)", async () => {
    await makeService(true).deliverCallRing({
      workspaceId: "ws_1",
      targetUserId: "usr_1",
      attemptId: "callinv_01ABCDEF",
      callId: "call_1",
      streamId: "stream_dm",
      inviter: { id: "usr_2", name: "Ada" },
      mode: "video",
      expiresAt: "2026-07-19T12:00:45.000Z",
    })
    expect(findByUserId).not.toHaveBeenCalled()
  })

  it("does not send a ring cancel when the invitee's notification level is none", async () => {
    // The ring itself was suppressed, so nothing was queued to collapse — a cancel
    // that shows no notification would burn the browser's silent-push quota.
    await makeService(false, PrefNotificationLevels.NONE).deliverCallRingCancel({
      workspaceId: "ws_1",
      targetUserId: "usr_1",
      attemptId: "callinv_01ABCDEF",
      callId: "call_1",
      outcome: "cancelled",
    })
    expect(findByUserId).not.toHaveBeenCalled()
  })

  it("does not send a ring cancel while notifications are paused", async () => {
    await makeService(true).deliverCallRingCancel({
      workspaceId: "ws_1",
      targetUserId: "usr_1",
      attemptId: "callinv_01ABCDEF",
      callId: "call_1",
      outcome: "cancelled",
    })
    expect(findByUserId).not.toHaveBeenCalled()
  })

  it("never plans a push for a saved_reminder activity row: saved_reminder:fired owns that push", async () => {
    const payload = makeActivityPayload()
    payload.activity.activityType = ActivityTypes.SAVED_REMINDER
    await makeService(false).planActivityPush(EVENT, payload)
    expect(findByUserId).not.toHaveBeenCalled()
  })

  it("resolves the user's devices when notifications are not paused", async () => {
    await makeService(false).planActivityPush(EVENT, makeActivityPayload())
    expect(findByUserId).toHaveBeenCalledTimes(1)
  })
})

describe("PushService delivery options", () => {
  const subscription = {
    id: "push_sub_1",
    workspaceId: "ws_1",
    userId: "usr_1",
    endpoint: "https://push.example.com/sub",
    ...registrationKeys(),
    deviceKey: "device1",
    userAgent: null,
    generation: 1,
    receiptVersion: null,
    createdAt: new Date(),
    updatedAt: new Date(), // fresh re-registration → passes the session-expiry check
  }

  let findByUserId: ReturnType<typeof spyOn>
  let sendNotification: ReturnType<typeof spyOn>

  beforeEach(() => {
    findByUserId = spyOn(PushSubscriptionRepository, "findByUserId").mockResolvedValue([subscription])
    sendNotification = spyOn(webpush, "sendNotification").mockResolvedValue({
      statusCode: 201,
      body: "",
      headers: {},
    })
  })

  afterEach(() => {
    findByUserId.mockRestore()
    sendNotification.mockRestore()
  })

  it("sends a call ring with high urgency, a 45s TTL, and an attempt-keyed topic", async () => {
    await makeService(false).deliverCallRing({
      workspaceId: "ws_1",
      targetUserId: "usr_1",
      attemptId: "callinv_01ABCDEF",
      callId: "call_1",
      streamId: "stream_dm",
      inviter: { id: "usr_2", name: "Ada" },
      mode: "video",
      expiresAt: "2026-07-19T12:00:45.000Z",
    })

    expect(sendNotification).toHaveBeenCalledTimes(1)
    const [, payload, options] = sendNotification.mock.calls[0] as [unknown, string, Record<string, unknown>]
    expect(JSON.parse(payload).data).toMatchObject({ kind: "call_ring", attemptId: "callinv_01ABCDEF", mode: "video" })
    expect(options).toEqual({ timeout: 10_000, TTL: 45, urgency: "high", topic: "01ABCDEFc" })
  })

  it("sends the ring cancel on the same topic so an undelivered ring collapses to it", async () => {
    await makeService(false).deliverCallRingCancel({
      workspaceId: "ws_1",
      targetUserId: "usr_1",
      attemptId: "callinv_01ABCDEF",
      callId: "call_1",
      outcome: "cancelled",
      inviterName: "Ada",
    })

    const [, payload, options] = sendNotification.mock.calls[0] as [unknown, string, Record<string, unknown>]
    // Inviter name and outcome ride the cancel: the name lets the SW's fallback
    // title the caller, the outcome keeps an answered ring from reading "ended".
    expect(JSON.parse(payload).data).toMatchObject({
      kind: "call_ring_cancel",
      attemptId: "callinv_01ABCDEF",
      inviterName: "Ada",
      outcome: "cancelled",
    })
    expect(options).toEqual({ timeout: 10_000, TTL: 45, urgency: "high", topic: "01ABCDEFc" })
  })

  it("sends the diagnostic test push with a short TTL so it can't arrive stale", async () => {
    await makeService(false).deliverTestPush("ws_1", "usr_1")

    const [, , options] = sendNotification.mock.calls[0] as [unknown, string, Record<string, unknown>]
    expect(options).toEqual({ timeout: 10_000, TTL: 60, urgency: "high" })
  })

  it("records a stored registration whose keys cannot be encrypted to as invalid, without sending", async () => {
    findByUserId.mockResolvedValue([{ ...subscription, p256dh: "not-a-p256-point", auth: "short" }])

    const result = await makeService(false).deliverTestPush("ws_1", "usr_1")

    expect(sendNotification).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      attempted: 1,
      accepted: 0,
      failed: 1,
      devices: [{ subscriptionId: subscription.id, outcome: "invalid_registration", statusCode: null }],
    })
  })
})
