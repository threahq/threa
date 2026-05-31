import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { isChunkLoadError, runSwRecovery } from "./sw-recovery"

describe("isChunkLoadError", () => {
  it("detects Chromium/Firefox dynamic-import failures", () => {
    const err = new TypeError(
      "Failed to fetch dynamically imported module: https://app.threa.io/assets/workspace-layout-CZWcI4f9.js"
    )
    expect(isChunkLoadError(err)).toBe(true)
  })

  it("detects Safari dynamic-import failures", () => {
    const err = new TypeError("error loading dynamically imported module")
    expect(isChunkLoadError(err)).toBe(true)
  })

  it("detects older Edge module-script failures", () => {
    const err = new Error("Importing a module script failed")
    expect(isChunkLoadError(err)).toBe(true)
  })

  it("accepts raw string errors (thrown non-Error values)", () => {
    expect(isChunkLoadError("Failed to fetch dynamically imported module")).toBe(true)
  })

  it("does not match unrelated errors", () => {
    expect(isChunkLoadError(new Error("Network request failed"))).toBe(false)
    expect(isChunkLoadError(new TypeError("Cannot read properties of undefined"))).toBe(false)
    expect(isChunkLoadError(null)).toBe(false)
    expect(isChunkLoadError(undefined)).toBe(false)
    expect(isChunkLoadError({ message: "Failed to fetch dynamically imported module" })).toBe(false)
  })
})

describe("runSwRecovery", () => {
  const originalLocation = window.location

  beforeEach(() => {
    sessionStorage.clear()
    // jsdom's location.reload() throws "Not implemented" — replace it with a spy
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...originalLocation, reload: vi.fn() },
    })
  })

  afterEach(() => {
    Object.defineProperty(window, "location", { configurable: true, value: originalLocation })
    sessionStorage.clear()
  })

  it("returns false without reloading once the per-session cap is reached", async () => {
    sessionStorage.setItem("sw-recovery-attempts", "2")
    const result = await runSwRecovery()
    expect(result).toBe(false)
    expect(window.location.reload).not.toHaveBeenCalled()
  })

  it("increments the attempt counter on each auto-recovery call", async () => {
    await runSwRecovery()
    expect(sessionStorage.getItem("sw-recovery-attempts")).toBe("1")
    await runSwRecovery()
    expect(sessionStorage.getItem("sw-recovery-attempts")).toBe("2")
  })

  it("stamps the last-attempt time so the watchdog's reset can be cooldown-gated", async () => {
    const now = 1_700_000_000_000
    vi.spyOn(Date, "now").mockReturnValue(now)
    await runSwRecovery()
    // The index.html CSS watchdog reads this stamp and refuses to clear the
    // shared counter while it's recent — that's what stops a broken-chunk
    // reload loop from zeroing the counter and never reaching the cap.
    expect(sessionStorage.getItem("sw-recovery-last")).toBe(String(now))
  })

  it("force: true does not stamp the last-attempt time", async () => {
    const result = await runSwRecovery({ force: true })
    expect(result).toBe(true)
    expect(sessionStorage.getItem("sw-recovery-last")).toBeNull()
  })

  it("force: true bypasses the cap and does not touch the counter", async () => {
    sessionStorage.setItem("sw-recovery-attempts", "2")
    const result = await runSwRecovery({ force: true })
    expect(result).toBe(true)
    expect(sessionStorage.getItem("sw-recovery-attempts")).toBe("2")
    expect(window.location.reload).toHaveBeenCalledOnce()
  })
})
