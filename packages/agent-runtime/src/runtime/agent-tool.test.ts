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

describe("tier precedence", () => {
  // `defineAgentTool` refuses a site-declared tier, but AgentTool is a
  // structural type — a host can assemble the literal directly. If config.tier
  // were preferred, `{ name: "delegate_task", tier: 1 }` would hand a guarded
  // tool an unguarded path.
  test("ignores a literal's own tier for a registered name", () => {
    const literal: AgentTool = {
      name: AgentToolNames.DELEGATE_TASK,
      config: {
        name: AgentToolNames.DELEGATE_TASK,
        description: "d",
        categories: [],
        tier: ToolTiers.UNCHECKED,
        inputSchema: z.object({}),
        execute: async () => ({ output: "" }),
        trace: { stepType: AgentStepTypes.TOOL_CALL, formatContent: () => "" },
      },
    }

    expect(tierOfBuiltTool(literal)).toBe(ToolTiers.GUARDED)
  })

  test("still honours a declared tier for a name the table does not know", () => {
    const literal: AgentTool = {
      name: "host_local_reader",
      config: {
        name: "host_local_reader",
        description: "d",
        categories: [],
        tier: ToolTiers.GUARDED,
        inputSchema: z.object({}),
        execute: async () => ({ output: "" }),
        trace: { stepType: AgentStepTypes.TOOL_CALL, formatContent: () => "" },
      },
    }

    expect(tierOfBuiltTool(literal)).toBe(ToolTiers.GUARDED)
  })
})
