import { describe, expect, test } from "bun:test"
import { AGENT_TOOL_NAMES, AgentToolNames } from "./constants"
import {
  GUARDED_TOOL_NAMES,
  TOOL_TIERS,
  TOOL_TIERS_BY_NAME,
  ToolTiers,
  isAgentToolName,
  requiresGuardianReview,
  tierOfTool,
} from "./tool-tiers"

describe("TOOL_TIERS_BY_NAME", () => {
  test("every registered tool has a valid tier", () => {
    for (const name of AGENT_TOOL_NAMES) {
      expect(TOOL_TIERS).toContain(TOOL_TIERS_BY_NAME[name])
    }
  })

  test("the guarded set is exactly the tools at tier 2 or above", () => {
    const expected = AGENT_TOOL_NAMES.filter((name) => TOOL_TIERS_BY_NAME[name] >= ToolTiers.GUARDED)

    expect([...GUARDED_TOOL_NAMES]).toEqual([...expected])
  })

  // The one tool that carries the user's own authority: delegate_task compiles
  // a brief and hands it to the user's local agent, which executes with their
  // credentials on their machine. If a future edit drops it back to tier 1 the
  // guardian silently stops running on the highest-authority action in the
  // product, with no other signal — so it is asserted by name, not derived.
  test("delegate_task is guarded", () => {
    expect(TOOL_TIERS_BY_NAME[AgentToolNames.DELEGATE_TASK]).toBe(ToolTiers.GUARDED)
  })

  test("reads and in-stream participation stay unchecked", () => {
    const unchecked = [
      AgentToolNames.SEND_MESSAGE,
      AgentToolNames.WEB_SEARCH,
      AgentToolNames.SEARCH_MESSAGES,
      AgentToolNames.READ_ATTACHMENT,
      AgentToolNames.REACT_TO_MESSAGE,
      AgentToolNames.UPDATE_STREAM_BRIEF,
      AgentToolNames.SAVE_MEMO,
    ] as const

    for (const name of unchecked) {
      expect(TOOL_TIERS_BY_NAME[name]).toBe(ToolTiers.UNCHECKED)
    }
  })
})

describe("tierOfTool", () => {
  test("resolves a registered tool from the table", () => {
    expect(tierOfTool(AgentToolNames.DELEGATE_TASK)).toBe(ToolTiers.GUARDED)
    expect(tierOfTool(AgentToolNames.WEB_SEARCH)).toBe(ToolTiers.UNCHECKED)
  })

  // Host-local tools (the enclave's in-process readers) are not in the registry.
  // They read what the model already sees, so unchecked is correct — but the
  // fallback must be tier 1 by decision, not by an undefined leaking through.
  test("an unregistered name resolves to tier 1, not undefined", () => {
    expect(isAgentToolName("enclave_local_reader")).toBe(false)
    expect(tierOfTool("enclave_local_reader")).toBe(ToolTiers.UNCHECKED)
  })
})

describe("requiresGuardianReview", () => {
  test("gates at tier 2 and above", () => {
    expect(requiresGuardianReview(ToolTiers.UNCHECKED)).toBe(false)
    expect(requiresGuardianReview(ToolTiers.GUARDED)).toBe(true)
    expect(requiresGuardianReview(ToolTiers.CONFIRMED)).toBe(true)
  })
})
