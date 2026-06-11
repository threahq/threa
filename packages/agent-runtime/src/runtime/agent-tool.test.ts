import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { AgentStepTypes } from "@threa/types"
import { buildToolPromptSections, defineAgentTool, type AgentTool } from "./agent-tool"

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
