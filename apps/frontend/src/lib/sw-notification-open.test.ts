import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { installFakeCaches, uninstallFakeCaches } from "@/test/fake-caches"
import { SW_MSG_NOTIFICATION_CLICK } from "./sw-messages"
import { openNotificationTarget, type NotificationClients } from "./sw-notification-open"
import { takeNotificationTarget } from "./notification-target-storage"

beforeEach(installFakeCaches)
afterEach(uninstallFakeCaches)

const ORIGIN = "https://app.threa.io"
const TARGET = "/w/ws_1/s/stream_1?m=msg_1"

function client(url: string, focus: () => Promise<unknown>) {
  return { url, focus, postMessage: vi.fn() }
}

function clients(windows: Array<ReturnType<typeof client>>) {
  const openWindow = vi.fn(async () => null)
  const matchAll = vi.fn(async () => windows)
  const api: NotificationClients = { matchAll, openWindow }
  return { api, openWindow, matchAll }
}

describe("openNotificationTarget", () => {
  it("focuses a same-origin window and posts the destination to it", async () => {
    const window_ = client(`${ORIGIN}/w/ws_1/s/other`, async () => undefined)
    const { api, openWindow, matchAll } = clients([window_])

    await openNotificationTarget(api, ORIGIN, TARGET, "user_01AAA")

    // includeUncontrolled: a window loaded before this worker took control is the
    // one the viewer is looking at, and it is not in an uncontrolled-excluding match.
    expect(matchAll).toHaveBeenCalledWith({ type: "window", includeUncontrolled: true })
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

    expect(live.postMessage).toHaveBeenCalledWith({
      type: SW_MSG_NOTIFICATION_CLICK,
      url: TARGET,
      workosUserId: undefined,
    })
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

  it("stashes before it tries a window, so a relaunch racing the worker still reads it", async () => {
    let stashedWhenOpening: unknown = null
    const api: NotificationClients = {
      matchAll: async () => [],
      openWindow: async () => {
        stashedWhenOpening = await takeNotificationTarget()
        return null
      },
    }

    await openNotificationTarget(api, ORIGIN, TARGET, undefined)

    expect(stashedWhenOpening).toEqual({ url: TARGET, workosUserId: undefined })
  })

  it("settles when opening a window is refused, so the badge sync after it still runs", async () => {
    const api: NotificationClients = {
      matchAll: async () => [],
      openWindow: async () => {
        throw new DOMException("Not allowed to open a window", "InvalidAccessError")
      },
    }

    await expect(openNotificationTarget(api, ORIGIN, TARGET, undefined)).resolves.toBeUndefined()
  })
})
