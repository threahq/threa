import { describe, expect, test } from "bun:test"
import { AGENT_TOOL_NAMES, AgentToolNames } from "@threa/types"
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
        AgentToolNames.SAVE_MEMO,
      ].sort()
    )
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
