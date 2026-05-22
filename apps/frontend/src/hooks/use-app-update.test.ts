import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { reloadForUpdate, shouldNotifyUpdate, RELOAD_FRESH_ACK_TIMEOUT_MS } from "./use-app-update"
import { SW_MSG_RELOAD_FRESH } from "@/lib/sw-messages"

const RUNNING = "abc1234"

describe("shouldNotifyUpdate", () => {
  it("notifies when the server build is newer and not yet announced", () => {
    expect(shouldNotifyUpdate("def5678", RUNNING, null)).toBe(true)
  })

  it("stays silent when the server build matches what's running", () => {
    expect(shouldNotifyUpdate(RUNNING, RUNNING, null)).toBe(false)
  })

  it("stays silent for a deploy already announced (the remount/refocus re-toast bug)", () => {
    // User saw the toast for def5678, dismissed it, kept working on the old
    // build. A remount + refocus re-runs the check with the same delta.
    expect(shouldNotifyUpdate("def5678", RUNNING, "def5678")).toBe(false)
  })

  it("notifies again only for a genuinely newer build", () => {
    expect(shouldNotifyUpdate("ghi9012", RUNNING, "def5678")).toBe(true)
  })

  it("stays silent on an empty/missing server version", () => {
    expect(shouldNotifyUpdate("", RUNNING, null)).toBe(false)
  })
})

describe("reloadForUpdate", () => {
  const originalLocation = window.location
  const swDescriptor = Object.getOwnPropertyDescriptor(navigator, "serviceWorker")
  let reloadSpy: ReturnType<typeof vi.fn>

  const setController = (controller: unknown): void => {
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { controller, addEventListener: vi.fn() },
    })
  }

  beforeEach(() => {
    reloadSpy = vi.fn()
    // jsdom's location.reload() throws "Not implemented" — replace it with a spy.
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...originalLocation, reload: reloadSpy },
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    Object.defineProperty(window, "location", { configurable: true, value: originalLocation })
    if (swDescriptor) {
      Object.defineProperty(navigator, "serviceWorker", swDescriptor)
    } else {
      // jsdom has no serviceWorker by default — drop the stub we added.
      delete (navigator as { serviceWorker?: unknown }).serviceWorker
    }
  })

  it("reloads immediately when no SW controls the page (navigation already hits network)", async () => {
    setController(null)
    await reloadForUpdate()
    expect(reloadSpy).toHaveBeenCalledOnce()
  })

  it("asks the controlling SW for a fresh navigation, then reloads once it acks", async () => {
    let received: { type: string } | undefined
    const controller = {
      postMessage: vi.fn((message: { type: string }, transfer?: Transferable[]) => {
        received = message
        // Mimic the SW: ack on the transferred port so the reload proceeds.
        const port = transfer?.[0] as MessagePort | undefined
        port?.postMessage({ ok: true })
      }),
    }
    setController(controller)

    await reloadForUpdate()

    expect(controller.postMessage).toHaveBeenCalledOnce()
    expect(received).toEqual({ type: SW_MSG_RELOAD_FRESH })
    await vi.waitFor(() => expect(reloadSpy).toHaveBeenCalledOnce())
  })

  it("reloads anyway when the SW never acks (wedged worker can't strand Reload)", async () => {
    vi.useFakeTimers()
    // Controller that swallows the message without acking.
    setController({ postMessage: vi.fn() })

    const promise = reloadForUpdate()
    expect(reloadSpy).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(RELOAD_FRESH_ACK_TIMEOUT_MS)
    await promise
    expect(reloadSpy).toHaveBeenCalledOnce()
  })
})
