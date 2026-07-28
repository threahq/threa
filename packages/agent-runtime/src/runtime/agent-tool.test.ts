import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { AgentStepTypes, AgentToolNames, ToolTiers } from "@threa/types"
import { buildToolPromptSections, defineAgentTool, tierOfBuiltTool, type AgentTool } from "./agent-tool"

function makeTool(name: string, promptBlock?: string): AgentTool {
  return defineAgentTool({
    name,
    description: `${name} description`,
    categories: ["web"],
    ...(promptBlock !== undefined ? { promptBlock } : {}),
    inputSchema: z.object({}),
    execute: async () => ({ output: "ok" }),
    trace: {
      stepType: AgentStepTypes.WEB_SEARCH,
      formatContent: () => "",
    },
  })
}

describe("buildToolPromptSections", () => {
  test("joins prompt blocks in toolset order, skipping tools without prose", () => {
    const tools = [
      makeTool("alpha", "## Alpha\n\nUse alpha."),
      makeTool("silent"),
      makeTool("beta", "## Beta\n\nUse beta."),
    ]

    expect(buildToolPromptSections(tools)).toBe("## Alpha\n\nUse alpha.\n\n## Beta\n\nUse beta.")
  })

  test("returns an empty string when no tool carries prose", () => {
    expect(buildToolPromptSections([makeTool("silent")])).toBe("")
    expect(buildToolPromptSections([])).toBe("")
  })
})

describe("tier resolution", () => {
  test("a registered tool takes its tier from the table, not its definition site", () => {
    expect(tierOfBuiltTool(makeTool(AgentToolNames.DELEGATE_TASK))).toBe(ToolTiers.GUARDED)
    expect(tierOfBuiltTool(makeTool(AgentToolNames.WEB_SEARCH))).toBe(ToolTiers.UNCHECKED)
  })

  test("an unregistered host-local tool is tier 1", () => {
    expect(tierOfBuiltTool(makeTool("enclave_local_reader"))).toBe(ToolTiers.UNCHECKED)
  })

  // The point of resolving centrally: a definition site cannot claim a tier the
  // table disagrees with. Declaring one at all is the mistake, so it throws
  // rather than being quietly overwritten — a silently ignored `tier: 1` on a
  // guarded tool would read, in review, exactly like a tool that skips the
  // guardian.
  test("declaring a tier at the definition site throws", () => {
    expect(() =>
      defineAgentTool({
        name: AgentToolNames.WEB_SEARCH,
        description: "d",
        categories: ["web"],
        tier: ToolTiers.UNCHECKED,
        inputSchema: z.object({}),
        execute: async () => ({ output: "ok" }),
        trace: { stepType: AgentStepTypes.WEB_SEARCH, formatContent: () => "" },
      })
    ).toThrow(/TOOL_TIERS_BY_NAME/)
  })
})
