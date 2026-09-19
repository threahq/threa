import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { installFakeCaches, uninstallFakeCaches } from "@/test/fake-caches"
import { NOTIFICATION_TARGET_CACHE } from "./sw-messages"
import {
  NOTIFICATION_TARGET_TTL_MS,
  stashNotificationTarget,
  takeNotificationTarget,
} from "./notification-target-storage"

beforeEach(installFakeCaches)
afterEach(uninstallFakeCaches)

const TARGET = { url: "/w/ws_1/s/stream_1?m=msg_1", workosUserId: "user_01AAA" }

describe("notification target stash", () => {
  it("hands the tap's destination to the app", async () => {
    await stashNotificationTarget(TARGET, 1_000)
    expect(await takeNotificationTarget(2_000)).toEqual(TARGET)
  })

  it("is claimed once, so boot, resume and the SW message cannot double-navigate", async () => {
    await stashNotificationTarget(TARGET, 1_000)
    await takeNotificationTarget(1_000)
    expect(await takeNotificationTarget(1_000)).toBeNull()
  })

  it("expires, so an unclaimed tap never redirects a later visit", async () => {
    await stashNotificationTarget(TARGET, 1_000)
    expect(await takeNotificationTarget(1_000 + NOTIFICATION_TARGET_TTL_MS + 1)).toBeNull()
  })

  it("reads as absent with nothing stashed", async () => {
    expect(await takeNotificationTarget()).toBeNull()
  })

  it("rejects a destination that would leave the app", async () => {
    const cache = await caches.open(NOTIFICATION_TARGET_CACHE)
    await cache.put("/_notify/target", new Response(JSON.stringify({ url: "//evil.example/x", at: 1_000 })))
    expect(await takeNotificationTarget(1_000)).toBeNull()
  })

  it("rejects an entry with no timestamp rather than treating it as fresh", async () => {
    const cache = await caches.open(NOTIFICATION_TARGET_CACHE)
    await cache.put("/_notify/target", new Response(JSON.stringify({ url: TARGET.url })))
    expect(await takeNotificationTarget(1_000)).toBeNull()
  })

  it("survives a browser with no Cache API", async () => {
    Reflect.deleteProperty(globalThis, "caches")
    await stashNotificationTarget(TARGET)
    expect(await takeNotificationTarget()).toBeNull()
  })
})
