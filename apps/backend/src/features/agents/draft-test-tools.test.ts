import { describe, expect, test } from "bun:test"
import { AGENT_TOOL_NAMES, AgentToolNames, TOOL_TIERS_BY_NAME, ToolTiers } from "@threa/types"
import { DRAFT_TEST_EXCLUDED_TOOLS, stripDraftTestExcludedTools } from "./config"

describe("DRAFT_TEST_EXCLUDED_TOOLS", () => {
  test("excludes exactly the durable-write tools", () => {
    expect([...DRAFT_TEST_EXCLUDED_TOOLS].sort()).toEqual(
      [
        AgentToolNames.SCHEDULE_FOLLOW_UP,
        AgentToolNames.CANCEL_FOLLOW_UP,
        AgentToolNames.UPDATE_FOLLOW_UP,
        AgentToolNames.UPDATE_STREAM_BRIEF,
        AgentToolNames.DELEGATE_TASK,
        AgentToolNames.DELEGATE_TO_MODEL,
        AgentToolNames.SAVE_MEMO,
        AgentToolNames.UPDATE_USER_SETTINGS,
      ].sort()
    )
  })

  /**
   * Derived rather than listed, because the list above is hand-maintained and
   * hand-maintained sets go stale silently: `update_user_settings` was added to
   * the tier table and to the toolset but not here, so a persona under test
   * could write the tester's REAL preferences — which outlive the ephemeral
   * test stream, the exact thing this set exists to prevent. Tier 2 means
   * "durable state outside this stream or acts with the user's authority", so
   * every tier-2 tool qualifies by definition.
   */
  test("excludes every guarded tool, so the next one cannot be forgotten", () => {
    const guarded = AGENT_TOOL_NAMES.filter((name) => TOOL_TIERS_BY_NAME[name] >= ToolTiers.GUARDED)

    expect(guarded.length).toBeGreaterThan(0)
    for (const name of guarded) {
      expect(DRAFT_TEST_EXCLUDED_TOOLS.has(name)).toBe(true)
    }
  })

  test("every excluded name is a real tool in the catalog (no stale entry)", () => {
    for (const tool of DRAFT_TEST_EXCLUDED_TOOLS) {
      expect(AGENT_TOOL_NAMES).toContain(tool)
    }
  })

  test("read + in-stream tools are NOT excluded", () => {
    const kept = [
      AgentToolNames.SEND_MESSAGE,
      AgentToolNames.REACT_TO_MESSAGE,
      AgentToolNames.LIST_FOLLOW_UPS,
      AgentToolNames.DESCRIBE_MEMO,
      AgentToolNames.WEB_SEARCH,
      AgentToolNames.READ_URL,
      AgentToolNames.SEARCH_MESSAGES,
      AgentToolNames.READ_ATTACHMENT,
      AgentToolNames.GITHUB_REPOS,
      AgentToolNames.LINEAR_LIST_ISSUES,
      // `report_back` is bound only inside a subagent thread, so a test-drive
      // turn never builds it anyway — excluding it here would claim a durable
      // write it cannot make.
      AgentToolNames.REPORT_BACK,
    ]
    for (const tool of kept) {
      expect(DRAFT_TEST_EXCLUDED_TOOLS.has(tool)).toBe(false)
    }
  })
})

describe("stripDraftTestExcludedTools", () => {
  test("removes excluded tools, keeps the rest", () => {
    const stripped = stripDraftTestExcludedTools([
      AgentToolNames.SEND_MESSAGE,
      AgentToolNames.SAVE_MEMO,
      AgentToolNames.WEB_SEARCH,
      AgentToolNames.DELEGATE_TASK,
      AgentToolNames.SCHEDULE_FOLLOW_UP,
    ])
    expect(stripped).toEqual([AgentToolNames.SEND_MESSAGE, AgentToolNames.WEB_SEARCH])
  })

  test("passes null through unchanged (no explicit tool set)", () => {
    expect(stripDraftTestExcludedTools(null)).toBeNull()
  })
})
