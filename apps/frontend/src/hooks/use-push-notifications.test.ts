import { afterEach, describe, expect, it, vi } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import { usePushNotifications } from "./use-push-notifications"
import { api } from "@/api/client"

const swDescriptor = Object.getOwnPropertyDescriptor(navigator, "serviceWorker")
const notificationDescriptor = Object.getOwnPropertyDescriptor(window, "Notification")

function fakeSubscription(endpoint = "https://push.example/sub-1") {
  return {
    endpoint,
    options: { applicationServerKey: new Uint8Array([1, 2, 3]).buffer },
    toJSON: () => ({ endpoint, keys: { p256dh: "p256dh-key", auth: "auth-key" } }),
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

  it("drops the optimistic subscribed state when the handshake fails", async () => {
    installBrowserPush(fakeSubscription())
    vi.spyOn(api, "get").mockRejectedValue(new Error("network down"))
    vi.spyOn(console, "error").mockImplementation(() => {})

    const { result } = renderHook(() => usePushNotifications("ws_1"))

    await waitFor(() => expect(result.current.status).toBe("error"))
    expect(result.current.isSubscribed).toBe(false)
  })
})
