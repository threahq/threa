import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { reloadForUpdate, shouldNotifyUpdate, UPDATE_RELOAD_FALLBACK_MS } from "./use-app-update"

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

  const setRegistration = (registration: unknown): void => {
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        addEventListener: vi.fn(),
        getRegistration: () => Promise.resolve(registration),
      },
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

  it("still reloads within the fallback window when registration.update() never settles", async () => {
    // The regression: every guaranteed-reload path used to sit behind
    // `await registration.update()`. A hung update() (stalled SW-script fetch,
    // throttled/offline tab) dismissed the toast and then left Reload doing
    // nothing. The time-bounded fallback must fire regardless.
    vi.useFakeTimers()
    setRegistration({
      installing: null,
      waiting: null,
      update: () => new Promise<void>(() => {}), // never settles
    })

    await reloadForUpdate()
    expect(reloadSpy).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(UPDATE_RELOAD_FALLBACK_MS)
    expect(reloadSpy).toHaveBeenCalledOnce()
  })

  it("reloads immediately when there is no service worker registration", async () => {
    setRegistration(undefined)
    await reloadForUpdate()
    expect(reloadSpy).toHaveBeenCalledOnce()
  })

  it("falls back to a plain reload when registration.update() rejects", async () => {
    setRegistration({
      installing: null,
      waiting: null,
      update: () => Promise.reject(new Error("update failed")),
    })

    await reloadForUpdate()
    await vi.waitFor(() => expect(reloadSpy).toHaveBeenCalledOnce())
  })

  it("reloads as soon as the update resolves with no pending worker, without waiting the fallback out", async () => {
    setRegistration({
      installing: null,
      waiting: null,
      update: () => Promise.resolve(),
    })

    await reloadForUpdate()
    await vi.waitFor(() => expect(reloadSpy).toHaveBeenCalledOnce())
  })
})
