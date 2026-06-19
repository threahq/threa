import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { reloadForUpdate, shouldNotifyUpdate, RELOAD_FALLBACK_TIMEOUT_MS } from "./use-app-update"
import { SW_MSG_SKIP_WAITING } from "@/lib/sw-messages"

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

  type Waiting = { postMessage: ReturnType<typeof vi.fn> }
  type Registration = { waiting: Waiting | null; update: ReturnType<typeof vi.fn> }

  /**
   * Stub navigator.serviceWorker. `registration: undefined` models getRegistration
   * resolving with no registration; a registration with `waiting: null` models no
   * parked worker. `fire("controllerchange")` invokes captured listeners so a test
   * can simulate the new worker taking control.
   */
  const setServiceWorker = (opts: { registration?: Registration }) => {
    const listeners: Record<string, Array<() => void>> = {}
    const sw = {
      getRegistration: vi.fn(async () => opts.registration),
      addEventListener: vi.fn((type: string, cb: () => void) => {
        ;(listeners[type] ??= []).push(cb)
      }),
      fire: (type: string) => listeners[type]?.forEach((cb) => cb()),
    }
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: sw })
    return sw
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

  it("reloads immediately when no worker is waiting, even after nudging update", async () => {
    const update = vi.fn(async () => {})
    setServiceWorker({ registration: { waiting: null, update } })

    await reloadForUpdate()

    expect(update).toHaveBeenCalledOnce()
    expect(reloadSpy).toHaveBeenCalledOnce()
  })

  it("activates the parked worker and reloads once it takes control", async () => {
    const waiting = { postMessage: vi.fn() }
    const update = vi.fn(async () => {})
    const sw = setServiceWorker({ registration: { waiting, update } })

    await reloadForUpdate()

    expect(update).not.toHaveBeenCalled() // already waiting — no need to nudge
    expect(waiting.postMessage).toHaveBeenCalledWith({ type: SW_MSG_SKIP_WAITING })
    expect(reloadSpy).not.toHaveBeenCalled()

    sw.fire("controllerchange")
    expect(reloadSpy).toHaveBeenCalledOnce()
  })

  it("reloads anyway when the worker never claims (wedged worker can't strand Reload)", async () => {
    vi.useFakeTimers()
    const waiting = { postMessage: vi.fn() }
    setServiceWorker({ registration: { waiting, update: vi.fn(async () => {}) } })

    await reloadForUpdate()
    expect(reloadSpy).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(RELOAD_FALLBACK_TIMEOUT_MS)
    expect(reloadSpy).toHaveBeenCalledOnce()
  })
})
