import { describe, expect, test } from "bun:test"
import { AgentToolNames, DEFAULT_USER_PREFERENCES, type UserPreferences } from "@threa/types"
import { buildToolSet, type ToolSetConfig } from "./tool-set"

const preferences: UserPreferences = {
  ...DEFAULT_USER_PREFERENCES,
  workspaceId: "ws_1",
  userId: "usr_1",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
}

function toolNames(config: Partial<ToolSetConfig>): string[] {
  return buildToolSet({ enabledTools: null, ...config }).map((tool) => tool.name)
}

/**
 * `update_user_settings` is available exactly when its deps were constructed —
 * there is no second condition inside `buildToolSet` to drift from the one in
 * `persona-agent`. These assert the seam: deps present → tool offered, deps
 * absent → tool does not exist, so the model is never told about a capability
 * it would only be refused.
 */
describe("update_user_settings availability", () => {
  const settings = { updateSettings: async () => preferences }

  test("is built when the caller supplied settings deps", () => {
    expect(toolNames({ settings })).toContain(AgentToolNames.UPDATE_USER_SETTINGS)
  })

  test("is absent without them — the channel/DM, no-human-trigger, and sealed cases", () => {
    expect(toolNames({})).not.toContain(AgentToolNames.UPDATE_USER_SETTINGS)
  })

  test("is absent when the persona has it disabled, even with deps", () => {
    expect(toolNames({ settings, enabledTools: [AgentToolNames.WEB_SEARCH] })).not.toContain(
      AgentToolNames.UPDATE_USER_SETTINGS
    )
  })

  // Its prose is advertised from the built toolset, so a turn without the tool
  // cannot be told it has one.
  test("carries its own prompt prose only when built", () => {
    const built = buildToolSet({ enabledTools: null, settings })
    const tool = built.find((t) => t.name === AgentToolNames.UPDATE_USER_SETTINGS)

    expect(tool?.config.promptBlock).toContain("update_user_settings")
  })
})
