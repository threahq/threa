import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

const originalLocation = window.location

let dispose: () => void = () => {}
let now = 1_700_000_000_000

async function install() {
  vi.resetModules()
  const mod = await import("./crash-recovery")
  dispose = mod.installCrashRecovery()
}

function resume() {
  document.dispatchEvent(new Event("resume"))
}

function emitError(error: unknown, message: string) {
  window.dispatchEvent(new ErrorEvent("error", { error, message }))
}

function emitRejection(reason: unknown) {
  const event = new Event("unhandledrejection")
  Object.defineProperty(event, "reason", { value: reason, configurable: true })
  window.dispatchEvent(event)
}

describe("installCrashRecovery", () => {
  beforeEach(() => {
    now = 1_700_000_000_000
    vi.spyOn(Date, "now").mockImplementation(() => now)
    sessionStorage.clear()
    // jsdom's location.reload() throws "Not implemented" — replace it with a spy
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...originalLocation, reload: vi.fn() },
    })
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response("")))
    )
  })

  afterEach(() => {
    dispose()
    Object.defineProperty(window, "location", { configurable: true, value: originalLocation })
    sessionStorage.clear()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("reloads when a non-ignorable error fires shortly after a resume", async () => {
    await install()
    resume()
    emitRejection(new TypeError("Cannot read properties of undefined"))

    expect(window.location.reload).toHaveBeenCalledOnce()
    expect(sessionStorage.getItem("crash-reload-count")).toBe("1")
  })

  it("does not reload for an error that fires long after the last resume", async () => {
    await install()
    resume()
    now += 20_000
    emitError(new TypeError("boom"), "boom")

    expect(window.location.reload).not.toHaveBeenCalled()
  })

  it("does not reload without any prior resume", async () => {
    await install()
    // lastResumeAt is still 0, so any real timestamp is far outside the window.
    emitRejection(new TypeError("boom"))

    expect(window.location.reload).not.toHaveBeenCalled()
  })

  it("ignores routine ResizeObserver and aborted-request noise", async () => {
    await install()
    resume()
    emitError(undefined, "ResizeObserver loop completed with undelivered notifications.")
    emitRejection(new DOMException("The user aborted a request.", "AbortError"))
    emitRejection(new TypeError("Failed to fetch"))

    expect(window.location.reload).not.toHaveBeenCalled()
  })

  it("stops reloading once the per-session cap is reached", async () => {
    sessionStorage.setItem("crash-reload-count", "2")
    sessionStorage.setItem("crash-reload-last", String(now))
    await install()
    resume()
    emitRejection(new TypeError("boom"))

    expect(window.location.reload).not.toHaveBeenCalled()
  })

  it("resets the reload budget when the last attempt is long past", async () => {
    sessionStorage.setItem("crash-reload-count", "2")
    sessionStorage.setItem("crash-reload-last", String(now - 120_000))
    await install()
    resume()
    emitRejection(new TypeError("boom"))

    expect(window.location.reload).toHaveBeenCalledOnce()
    expect(sessionStorage.getItem("crash-reload-count")).toBe("1")
  })

  it("routes chunk-load failures into sw-recovery instead of the resume-crash path", async () => {
    await install()
    // No resume needed — a stale-deploy chunk failure recovers regardless of timing.
    emitRejection(new TypeError("Failed to fetch dynamically imported module: https://app.threa.io/assets/x-AbC123.js"))

    await vi.waitFor(() => expect(window.location.reload).toHaveBeenCalledOnce())
    // sw-recovery uses its own counter; the resume-crash counter stays untouched.
    expect(sessionStorage.getItem("sw-recovery-attempts")).toBe("1")
    expect(sessionStorage.getItem("crash-reload-count")).toBeNull()
  })
})
