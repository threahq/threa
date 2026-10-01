import { afterEach, describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"
import { usePushNotifications } from "./use-push-notifications"
import { api } from "@/api/client"

const swDescriptor = Object.getOwnPropertyDescriptor(navigator, "serviceWorker")
const notificationDescriptor = Object.getOwnPropertyDescriptor(window, "Notification")

function fakeSubscription(
  endpoint = "https://push.example/sub-1",
  keys: { p256dh?: string; auth?: string } = { p256dh: "p256dh-key", auth: "auth-key" }
) {
  return {
    endpoint,
    options: { applicationServerKey: new Uint8Array([1, 2, 3]).buffer },
    toJSON: () => ({ endpoint, keys }),
    unsubscribe: vi.fn().mockResolvedValue(true),
  }
}

/** Stubs the browser push surface: granted permission, ready SW, given existing subscription. */
function installBrowserPush(existingSubscription: ReturnType<typeof fakeSubscription> | null) {
  const pushManager = {
    getSubscription: vi.fn().mockResolvedValue(existingSubscription),
    subscribe: vi.fn().mockResolvedValue(fakeSubscription()),
  }
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: { ready: Promise.resolve({ pushManager }) },
  })
  Object.defineProperty(window, "Notification", {
    configurable: true,
    value: { permission: "granted", requestPermission: vi.fn() },
  })
  return pushManager
}

afterEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
  if (swDescriptor) {
    Object.defineProperty(navigator, "serviceWorker", swDescriptor)
  } else {
    delete (navigator as { serviceWorker?: unknown }).serviceWorker
  }
  if (notificationDescriptor) {
    Object.defineProperty(window, "Notification", notificationDescriptor)
  } else {
    delete (window as { Notification?: unknown }).Notification
  }
})

describe("usePushNotifications", () => {
  it("reflects an existing browser subscription before the backend handshake completes", async () => {
    installBrowserPush(fakeSubscription())
    // Hold the VAPID config fetch open — the regression was isSubscribed
    // staying false (unchecked checklist task) for the seconds this
    // round-trip takes on app start.
    vi.spyOn(api, "get").mockReturnValue(new Promise(() => {}))
    const post = vi.spyOn(api, "post").mockResolvedValue(undefined)

    const { result } = renderHook(() => usePushNotifications("ws_1"))

    await waitFor(() => expect(result.current.isSubscribed).toBe(true))
    // The handshake is still in flight — the early flip didn't come from it.
    expect(result.current.status).toBe("subscribing")
    expect(post).not.toHaveBeenCalled()
  })

  it("stays unsubscribed until the handshake completes when the browser holds no subscription", async () => {
    installBrowserPush(null)
    vi.spyOn(api, "get").mockResolvedValue({ vapidPublicKey: "dGVzdGtleQ", enabled: true })
    const post = vi.spyOn(api, "post").mockResolvedValue(undefined)

    const { result } = renderHook(() => usePushNotifications("ws_1"))

    await waitFor(() => expect(result.current.status).toBe("subscribed"))
    expect(result.current.isSubscribed).toBe(true)
    expect(post).toHaveBeenCalledWith(
      "/api/workspaces/ws_1/push/subscribe",
      expect.objectContaining({ endpoint: "https://push.example/sub-1" }),
      expect.anything()
    )
  })

  describe("when a background refresh fails", () => {
    // base64url of the fake subscription's applicationServerKey, so the browser subscription is reused.
    const MATCHING_VAPID = { vapidPublicKey: "AQID", enabled: true }

    async function subscribedThenRefreshFailing(refreshedBinding: ReturnType<typeof fakeSubscription>) {
      const pushManager = installBrowserPush(fakeSubscription())
      vi.spyOn(api, "get").mockResolvedValue(MATCHING_VAPID)
      const post = vi
        .spyOn(api, "post")
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("network down"))
      vi.spyOn(console, "error").mockImplementation(() => {})
      const { result } = renderHook(() => usePushNotifications("ws_1"))
      await waitFor(() => expect(result.current.status).toBe("subscribed"))

      pushManager.getSubscription.mockResolvedValue(refreshedBinding)
      window.dispatchEvent(new Event("pushsubscriptionchanged"))
      await waitFor(() => expect(post).toHaveBeenCalledTimes(2))
      await waitFor(() => expect(result.current.status).not.toBe("subscribing"))
      return {
        state: { isSubscribed: result.current.isSubscribed, status: result.current.status },
        endpoints: post.mock.calls.map((call) => (call[1] as { endpoint: string }).endpoint),
      }
    }

    it("should keep the binding the backend already confirmed", async () => {
      expect(await subscribedThenRefreshFailing(fakeSubscription())).toEqual({
        state: { isSubscribed: true, status: "subscribed" },
        endpoints: ["https://push.example/sub-1", "https://push.example/sub-1"],
      })
    })

    it("should not call a new binding registered when the backend never confirmed it", async () => {
      expect(await subscribedThenRefreshFailing(fakeSubscription("https://push.example/sub-2"))).toEqual({
        state: { isSubscribed: false, status: "error" },
        endpoints: ["https://push.example/sub-1", "https://push.example/sub-2"],
      })
    })

    it.each([
      ["p256dh", { p256dh: "p256dh-rotated", auth: "auth-key" }],
      ["auth", { p256dh: "p256dh-key", auth: "auth-rotated" }],
    ])("should not call rotated %s keys registered when the backend never confirmed them", async (_, keys) => {
      expect(await subscribedThenRefreshFailing(fakeSubscription("https://push.example/sub-1", keys))).toEqual({
        state: { isSubscribed: false, status: "error" },
        endpoints: ["https://push.example/sub-1", "https://push.example/sub-1"],
      })
    })

    it("should not treat a subscription without encryption keys as the confirmed binding", async () => {
      const pushManager = installBrowserPush(fakeSubscription())
      vi.spyOn(api, "get").mockResolvedValue(MATCHING_VAPID)
      const post = vi.spyOn(api, "post").mockResolvedValue(undefined)
      vi.spyOn(console, "error").mockImplementation(() => {})
      const { result } = renderHook(() => usePushNotifications("ws_1"))
      await waitFor(() => expect(result.current.status).toBe("subscribed"))

      pushManager.getSubscription.mockResolvedValue(
        fakeSubscription("https://push.example/sub-1", { p256dh: "p256dh-key" })
      )
      window.dispatchEvent(new Event("pushsubscriptionchanged"))

      await waitFor(() => expect(result.current.status).toBe("error"))
      expect({ isSubscribed: result.current.isSubscribed, posts: post.mock.calls.length }).toEqual({
        isSubscribed: false,
        posts: 1,
      })
    })

    it("should not keep rotated keys registered when the handshake fails before reaching the backend", async () => {
      const pushManager = installBrowserPush(fakeSubscription())
      vi.spyOn(api, "get").mockResolvedValueOnce(MATCHING_VAPID).mockRejectedValueOnce(new Error("network down"))
      const post = vi.spyOn(api, "post").mockResolvedValue(undefined)
      vi.spyOn(console, "error").mockImplementation(() => {})
      const { result } = renderHook(() => usePushNotifications("ws_1"))
      await waitFor(() => expect(result.current.status).toBe("subscribed"))

      pushManager.getSubscription.mockResolvedValue(
        fakeSubscription("https://push.example/sub-1", { p256dh: "p256dh-rotated", auth: "auth-key" })
      )
      await act(() => result.current.retry())

      expect({
        isSubscribed: result.current.isSubscribed,
        status: result.current.status,
        posts: post.mock.calls.length,
      }).toEqual({
        isSubscribed: false,
        status: "error",
        posts: 1,
      })
    })

    it("should keep rotated keys once the backend confirmed them", async () => {
      const pushManager = installBrowserPush(fakeSubscription())
      vi.spyOn(api, "get").mockResolvedValue(MATCHING_VAPID)
      const post = vi
        .spyOn(api, "post")
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("network down"))
      vi.spyOn(console, "error").mockImplementation(() => {})
      const { result } = renderHook(() => usePushNotifications("ws_1"))
      await waitFor(() => expect(result.current.status).toBe("subscribed"))

      pushManager.getSubscription.mockResolvedValue(
        fakeSubscription("https://push.example/sub-1", { p256dh: "p256dh-rotated", auth: "auth-rotated" })
      )
      window.dispatchEvent(new Event("pushsubscriptionchanged"))
      await waitFor(() => expect(post).toHaveBeenCalledTimes(2))
      await waitFor(() => expect(result.current.status).toBe("subscribed"))
      window.dispatchEvent(new Event("pushsubscriptionchanged"))
      await waitFor(() => expect(post).toHaveBeenCalledTimes(3))
      await waitFor(() => expect(result.current.status).not.toBe("subscribing"))

      expect({
        isSubscribed: result.current.isSubscribed,
        status: result.current.status,
        keys: post.mock.calls.map((call) => (call[1] as { p256dh: string }).p256dh),
      }).toEqual({
        isSubscribed: true,
        status: "subscribed",
        keys: ["p256dh-key", "p256dh-rotated", "p256dh-rotated"],
      })
    })
  })

  it("drops the optimistic subscribed state when the handshake fails", async () => {
    installBrowserPush(fakeSubscription())
    vi.spyOn(api, "get").mockRejectedValue(new Error("network down"))
    vi.spyOn(console, "error").mockImplementation(() => {})

    const { result } = renderHook(() => usePushNotifications("ws_1"))

    await waitFor(() => expect(result.current.status).toBe("error"))
    expect(result.current.isSubscribed).toBe(false)
  })
})
