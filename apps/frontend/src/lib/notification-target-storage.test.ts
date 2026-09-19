import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  NOTIFICATION_TARGET_TTL_MS,
  stashNotificationTarget,
  takeNotificationTarget,
} from "./notification-target-storage"

/** Minimal in-memory CacheStorage — jsdom ships none. */
class FakeCache {
  private readonly entries = new Map<string, Response>()
  async put(request: string, response: Response): Promise<void> {
    this.entries.set(request, response)
  }
  async match(request: string): Promise<Response | undefined> {
    return this.entries.get(request)?.clone()
  }
  async delete(request: string): Promise<boolean> {
    return this.entries.delete(request)
  }
}

beforeEach(() => {
  const caches_ = new Map<string, FakeCache>()
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      open: async (name: string) => {
        let cache = caches_.get(name)
        if (!cache) {
          cache = new FakeCache()
          caches_.set(name, cache)
        }
        return cache
      },
    },
  })
})

afterEach(() => {
  Reflect.deleteProperty(globalThis, "caches")
})

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

  it("survives a browser with no Cache API", async () => {
    Reflect.deleteProperty(globalThis, "caches")
    await stashNotificationTarget(TARGET)
    expect(await takeNotificationTarget()).toBeNull()
  })
})
