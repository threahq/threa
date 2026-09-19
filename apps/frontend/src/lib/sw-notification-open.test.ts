import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { SW_MSG_NOTIFICATION_CLICK } from "./sw-messages"
import { openNotificationTarget, type NotificationClients } from "./sw-notification-open"
import { takeNotificationTarget } from "./notification-target-storage"

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

const ORIGIN = "https://app.threa.io"
const TARGET = "/w/ws_1/s/stream_1?m=msg_1"

function client(url: string, focus: () => Promise<unknown>) {
  return { url, focus, postMessage: vi.fn() }
}

function clients(windows: Array<ReturnType<typeof client>>) {
  const openWindow = vi.fn(async () => null)
  const api: NotificationClients = { matchAll: async () => windows, openWindow }
  return { api, openWindow }
}

describe("openNotificationTarget", () => {
  it("focuses a same-origin window and posts the destination to it", async () => {
    const window_ = client(`${ORIGIN}/w/ws_1/s/other`, async () => undefined)
    const { api, openWindow } = clients([window_])

    await openNotificationTarget(api, ORIGIN, TARGET, "user_01AAA")

    expect(window_.postMessage).toHaveBeenCalledWith({
      type: SW_MSG_NOTIFICATION_CLICK,
      url: TARGET,
      workosUserId: "user_01AAA",
    })
    expect(openWindow).not.toHaveBeenCalled()
  })

  it("opens a window when focusing the client throws, instead of dropping the tap", async () => {
    const frozen = client(`${ORIGIN}/w/ws_1/s/other`, async () => {
      throw new DOMException("Not allowed to focus a client", "InvalidAccessError")
    })
    const { api, openWindow } = clients([frozen])

    await openNotificationTarget(api, ORIGIN, TARGET, undefined)

    expect(frozen.postMessage).not.toHaveBeenCalled()
    expect(openWindow).toHaveBeenCalledWith(`${ORIGIN}${TARGET}`)
  })

  it("tries the next window when one refuses focus", async () => {
    const frozen = client(`${ORIGIN}/a`, async () => {
      throw new DOMException("Not allowed to focus a client", "InvalidAccessError")
    })
    const live = client(`${ORIGIN}/b`, async () => undefined)
    const { api, openWindow } = clients([frozen, live])

    await openNotificationTarget(api, ORIGIN, TARGET, undefined)

    expect(live.postMessage).toHaveBeenCalledTimes(1)
    expect(openWindow).not.toHaveBeenCalled()
  })

  it("opens a window when only another origin is running", async () => {
    const foreign = client("https://example.com/", async () => undefined)
    const { api, openWindow } = clients([foreign])

    await openNotificationTarget(api, ORIGIN, TARGET, undefined)

    expect(foreign.postMessage).not.toHaveBeenCalled()
    expect(openWindow).toHaveBeenCalledWith(`${ORIGIN}${TARGET}`)
  })

  it("stashes the destination on every path, so a lost message or dropped launch URL still lands", async () => {
    const { api } = clients([])
    await openNotificationTarget(api, ORIGIN, TARGET, "user_01AAA")
    expect(await takeNotificationTarget()).toEqual({ url: TARGET, workosUserId: "user_01AAA" })

    const focused = client(`${ORIGIN}/`, async () => undefined)
    await openNotificationTarget(clients([focused]).api, ORIGIN, TARGET, undefined)
    expect(await takeNotificationTarget()).toEqual({ url: TARGET, workosUserId: undefined })
  })
})
