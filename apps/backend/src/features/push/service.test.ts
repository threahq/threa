import { describe, it, expect, spyOn, beforeEach, afterEach } from "bun:test"
import webpush from "web-push"
import type { Pool } from "pg"
import { ActivityTypes, PrefNotificationLevels } from "@threa/types"
import { PushService } from "./service"
import { PushSubscriptionRepository } from "./repository"
import type { ActivityCreatedOutboxPayload } from "../../lib/outbox"

// A do-not-disturb window must stop push at the source: the service should
// never even look up the user's devices when notifications are paused.
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
    },
  }
}

// Fake pool good enough for getTargetSubscriptions, which only runs when not
// paused; findByUserId is stubbed so the client is never queried in anger.
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
