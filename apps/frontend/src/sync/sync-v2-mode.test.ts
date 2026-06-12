import { describe, it, expect, beforeEach } from "vitest"
import { defaultFeatureFlags, defaultFeatureFlagValue, type FeatureFlags } from "@threa/types"
import { mirrorSyncV2Mode, readMirroredSyncV2Mode, resolveSyncV2Mode, type SyncV2CursorMode } from "./sync-v2-mode"

const WORKSPACE_ID = "ws_mode_test"

function flags(mode: SyncV2CursorMode): FeatureFlags {
  return { ...defaultFeatureFlags(), "sync-v2-cursor": mode }
}

describe("sync-v2 mode mirror", () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it("round-trips the delivered mode per workspace", () => {
    mirrorSyncV2Mode(WORKSPACE_ID, flags("active"))
    mirrorSyncV2Mode("ws_other", flags("off"))

    expect(readMirroredSyncV2Mode(WORKSPACE_ID)).toBe("active")
    expect(readMirroredSyncV2Mode("ws_other")).toBe("off")
  })

  it("returns null when nothing was mirrored (first-ever boot)", () => {
    expect(readMirroredSyncV2Mode(WORKSPACE_ID)).toBeNull()
  })

  it("ignores a stored value the registry no longer declares (stale mirror)", () => {
    localStorage.setItem(`sync-v2-mode:${WORKSPACE_ID}`, "retired-value")

    expect(readMirroredSyncV2Mode(WORKSPACE_ID)).toBeNull()
  })

  it("keeps the last mirrored value when a delivery carries no flag map", () => {
    mirrorSyncV2Mode(WORKSPACE_ID, flags("active"))
    mirrorSyncV2Mode(WORKSPACE_ID, undefined)

    expect(readMirroredSyncV2Mode(WORKSPACE_ID)).toBe("active")
  })
})

describe("resolveSyncV2Mode", () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it("prefers the delivered flag value over the mirror", () => {
    mirrorSyncV2Mode(WORKSPACE_ID, flags("active"))

    expect(resolveSyncV2Mode(WORKSPACE_ID, "off")).toBe("off")
  })

  it("falls back to the mirror while the flag is unknown", () => {
    mirrorSyncV2Mode(WORKSPACE_ID, flags("active"))

    expect(resolveSyncV2Mode(WORKSPACE_ID, null)).toBe("active")
  })

  it("falls back to the registry default with no mirror", () => {
    expect(resolveSyncV2Mode(WORKSPACE_ID, null)).toBe(defaultFeatureFlagValue("sync-v2-cursor"))
  })
})
