import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { AgentStepTypes, type ToolPrivacyCategory } from "@threa/types"
import type { AgentTool } from "./agent-tool"
import { defineAgentTool } from "./agent-tool"
import { negotiateCapabilities } from "./negotiate-capabilities"

function makeTool(name: string, categories: readonly ToolPrivacyCategory[]): AgentTool {
  return defineAgentTool({
    name,
    description: `${name} description`,
    categories,
    inputSchema: z.object({}),
    execute: async () => ({ output: "ok" }),
    trace: {
      stepType: AgentStepTypes.WEB_SEARCH,
      formatContent: () => "",
    },
  })
}

describe("negotiateCapabilities", () => {
  const webSearch = makeTool("web_search", ["web"])
  const searchMessages = makeTool("search_messages", ["workspace"])
  const githubGetIssue = makeTool("github_get_issue", ["github", "web"])
  const reply = makeTool("send_message", ["messaging"])
  const conversationLocal = makeTool("load_attachment", [])

  test("no policy means no restriction", () => {
    const tools = [webSearch, searchMessages, githubGetIssue]
    expect(negotiateCapabilities({ streamPolicy: null, tools }).tools).toEqual(tools)
    expect(negotiateCapabilities({ streamPolicy: undefined, tools }).tools).toEqual(tools)
  })

  test("filters on any-intersection of each tool's own categories", () => {
    const { tools } = negotiateCapabilities({
      streamPolicy: ["web"],
      tools: [webSearch, searchMessages, githubGetIssue],
    })
    // github_get_issue rides the `web` grant (public-web-class egress);
    // workspace reads drop.
    expect(tools).toEqual([webSearch, githubGetIssue])
  })

  test("an empty policy still passes messaging and conversation-local tools", () => {
    const { tools } = negotiateCapabilities({
      streamPolicy: [],
      tools: [webSearch, reply, conversationLocal, searchMessages],
    })
    expect(tools).toEqual([reply, conversationLocal])
  })
})
