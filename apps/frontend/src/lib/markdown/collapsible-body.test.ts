import { describe, expect, it } from "vitest"
import {
  DEFAULT_MESSAGE_COLLAPSE_AT_HEIGHT,
  DEFAULT_MESSAGE_COLLAPSE_TO_HEIGHT,
  DEFAULT_USER_PREFERENCES,
  type UserPreferences,
} from "@threa/types"
import { resolveMessageCollapseSettings } from "./collapsible-body"

function preferences(overrides: Partial<UserPreferences> = {}): UserPreferences {
  return {
    workspaceId: "ws_test",
    userId: "usr_test",
    ...DEFAULT_USER_PREFERENCES,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  }
}

describe("resolveMessageCollapseSettings", () => {
  it("returns defaults when preferences are missing", () => {
    expect(resolveMessageCollapseSettings()).toEqual({
      enabled: false,
      collapseAtHeight: DEFAULT_MESSAGE_COLLAPSE_AT_HEIGHT,
      collapseToHeight: DEFAULT_MESSAGE_COLLAPSE_TO_HEIGHT,
    })
  })

  it("passes through enabled and configured heights", () => {
    expect(
      resolveMessageCollapseSettings(
        preferences({ messageCollapseEnabled: true, messageCollapseAtHeight: 640, messageCollapseToHeight: 320 })
      )
    ).toEqual({ enabled: true, collapseAtHeight: 640, collapseToHeight: 320 })
  })

  it("clamps collapse-to height to collapse-at height", () => {
    expect(
      resolveMessageCollapseSettings(
        preferences({ messageCollapseEnabled: true, messageCollapseAtHeight: 240, messageCollapseToHeight: 360 })
      )
    ).toEqual({ enabled: true, collapseAtHeight: 240, collapseToHeight: 240 })
  })
})
