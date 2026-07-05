import { describe, it, expect, spyOn, beforeEach, afterEach } from "bun:test"
import webpush from "web-push"
import type { Pool } from "pg"
import { ActivityTypes, PrefNotificationLevels } from "@threa/types"
import { PushService } from "./service"
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

const fakePool = {
  connect: async () => ({ query: async () => ({ rows: [] }), release: () => {} }),
} as unknown as Pool

function makeService(isNotificationPaused: boolean): PushService {
  const keys = webpush.generateVAPIDKeys()
  return new PushService({
    pool: fakePool,
    vapidConfig: { publicKey: keys.publicKey, privateKey: keys.privateKey, subject: "mailto:test@example.com" },
    lookups: {
      getUserNotificationLevel: async () => PrefNotificationLevels.ALL,
      isNotificationPaused: async () => isNotificationPaused,
      getStreamType: async () => "channel",
      getWorkosUserId: async () => "workos_1",
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
    await makeService(true).deliverPushForActivity(makeActivityPayload())
    expect(findByUserId).not.toHaveBeenCalled()
  })

  it("resolves the user's devices when notifications are not paused", async () => {
    await makeService(false).deliverPushForActivity(makeActivityPayload())
    expect(findByUserId).toHaveBeenCalledTimes(1)
  })
})

describe("PushService delivery options", () => {
  const subscription = {
    id: "push_sub_1",
    workspaceId: "ws_1",
    userId: "usr_1",
    endpoint: "https://push.example.com/sub",
    p256dh: "p256dh",
    auth: "auth",
    deviceKey: "device1",
    userAgent: null,
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

  it("sends message pushes with a timeout, high urgency, bounded TTL, and a per-stream topic", async () => {
    await makeService(false).deliverPushForActivity(makeActivityPayload())

    expect(sendNotification).toHaveBeenCalledTimes(1)
    const [, , options] = sendNotification.mock.calls[0] as [unknown, string, Record<string, unknown>]
    expect(options).toEqual({
      timeout: 10_000,
      TTL: 24 * 60 * 60,
      urgency: "high",
      topic: "1", // ULID part of stream_1; mentions get an "m" suffix
    })
  })

  it("keeps mention pushes on a distinct topic so they don't collapse into message pushes", async () => {
    const payload = makeActivityPayload()
    payload.activity.activityType = ActivityTypes.MENTION
    await makeService(false).deliverPushForActivity(payload)

    const [, , options] = sendNotification.mock.calls[0] as [unknown, string, Record<string, unknown>]
    expect(options.topic).toBe("1m")
  })

  it("sends the diagnostic test push with a short TTL so it can't arrive stale", async () => {
    await makeService(false).deliverTestPush("ws_1", "usr_1")

    const [, , options] = sendNotification.mock.calls[0] as [unknown, string, Record<string, unknown>]
    expect(options).toEqual({ timeout: 10_000, TTL: 60, urgency: "high" })
  })
})
