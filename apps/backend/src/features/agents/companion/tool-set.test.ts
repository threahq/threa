import { describe, expect, test } from "bun:test"
import { AgentToolNames, DEFAULT_USER_PREFERENCES, type UserPreferences } from "@threa/types"
import { buildToolSet, type ToolSetConfig } from "./tool-set"
import type { WorkspaceToolDeps } from "../tools/tool-deps"

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
  const settings = { updateSettings: async () => ({ before: preferences, after: preferences }) }

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

const workspace: WorkspaceToolDeps = {
  db: {} as WorkspaceToolDeps["db"],
  workspaceId: "ws_1",
  accessibleStreamIds: ["stream_1"],
  invokingUserId: "usr_1",
  searchService: {} as WorkspaceToolDeps["searchService"],
  storage: {} as WorkspaceToolDeps["storage"],
  attachmentService: {} as WorkspaceToolDeps["attachmentService"],
  memoExplorer: {} as WorkspaceToolDeps["memoExplorer"],
}

describe("search_messages prompt guidance", () => {
  test("carries its own prompt prose only when built", () => {
    const built = buildToolSet({ enabledTools: null, workspace })
    const tool = built.find((t) => t.name === AgentToolNames.SEARCH_MESSAGES)

    expect(tool?.config.promptBlock).toContain("## Searching Messages")
    expect(tool?.config.promptBlock).toContain(
      "Write the query as a description of the thing: who was involved, what it was about, what happened. Do not compress it into keywords."
    )
    expect(tool?.config.promptBlock).toContain(
      "Do at least two differently phrased searches before concluding something is not there"
    )
    expect(tool?.config.promptBlock).toContain("Set `exact=true` only for literal strings")
  })

  test("is absent without workspace deps", () => {
    expect(toolNames({})).not.toContain(AgentToolNames.SEARCH_MESSAGES)
  })
})

describe("workspace_research prompt guidance", () => {
  test("tells the model to pass the user's own description rather than keywords", () => {
    const built = buildToolSet({ enabledTools: null, runWorkspaceAgent: async () => ({}) as never })
    const tool = built.find((t) => t.name === "workspace_research")

    expect(tool?.config.promptBlock).toContain(
      "The user describes what they want by direction rather than detail — pass their description in their own words, with any names, places or time hints they gave, instead of reducing it to keywords"
    )
  })
})
