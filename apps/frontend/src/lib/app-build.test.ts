import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { currentAppBuiltAt, currentAppInstalledAt, currentAppVersion } from "./app-build"

describe("app build metadata", () => {
  beforeEach(() => {
    localStorage.clear()
    vi.stubGlobal("__APP_VERSION__", "abc1234")
    vi.stubGlobal("__APP_BUILT_AT__", "2026-07-14T12:30:00.000Z")
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("reads the metadata embedded by Vite", () => {
    expect(currentAppVersion()).toBe("abc1234")
    expect(currentAppBuiltAt()).toBe("2026-07-14T12:30:00.000Z")
  })

  it("preserves when a build first ran instead of replacing it on a later page visit", () => {
    const firstRun = new Date("2026-07-14T13:00:00.000Z")
    const laterVisit = new Date("2026-07-16T09:00:00.000Z")

    expect(currentAppInstalledAt(firstRun)).toEqual(firstRun)
    expect(currentAppInstalledAt(laterVisit)).toEqual(firstRun)
  })
})
