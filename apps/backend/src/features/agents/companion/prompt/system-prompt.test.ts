import { describe, expect, test } from "bun:test"
import { StreamTypes } from "@threa/types"
import { createReadUrlTool, createWebSearchTool } from "@threa/agent-runtime"
import type { Persona } from "../../persona-repository"
import type { StreamContext } from "../../context-builder"
import { createWorkspaceResearchTool } from "../../tools"
import { buildSystemPrompt } from "./system-prompt"

const persona: Persona = {
  id: "persona_ariadne",
  workspaceId: null,
  slug: "ariadne",
  name: "Ariadne",
  description: null,
  avatarEmoji: null,
  systemPrompt: "Base system prompt",
  model: "openai/gpt-5.4",
  temperature: 0.2,
  maxTokens: 1000,
  enabledTools: null,
  managedBy: "system",
  status: "active",
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
}

const scratchpadContext: StreamContext = {
  streamType: StreamTypes.SCRATCHPAD,
  streamInfo: {
    id: "stream_test",
    name: "Ideas",
    description: null,
    slug: null,
  },
  conversationHistory: [],
}

describe("buildSystemPrompt", () => {
  test("injects scratchpad custom instructions immediately after the base system prompt", () => {
    const prompt = buildSystemPrompt(persona, scratchpadContext, "Be concise and prioritize concrete next steps.")

    expect(prompt).toContain("Base system prompt\n\n## Scratchpad Custom Instructions")
    expect(prompt).toContain("Be concise and prioritize concrete next steps.")
    expect(prompt.indexOf("## Scratchpad Custom Instructions")).toBeLessThan(prompt.indexOf("## Context"))
  })

  test("omits the custom instruction section when no scratchpad prompt exists", () => {
    const prompt = buildSystemPrompt(persona, scratchpadContext, null)

    expect(prompt).not.toContain("## Scratchpad Custom Instructions")
  })

  test("tool sections come from the ACTUAL toolset — no tools means no tool prose", () => {
    const prompt = buildSystemPrompt(persona, scratchpadContext, null, undefined, undefined, null, [])

    expect(prompt).not.toContain("## Web Search")
    expect(prompt).not.toContain("## Reading URLs")
    expect(prompt).not.toContain("## Workspace Research")
    // The trust boundary is unconditional — tools or not, outputs are untrusted.
    expect(prompt).toContain("## Tool Output Trust Boundary")
  })

  test("each built tool contributes its own prompt section, in toolset order", () => {
    const tools = [
      createWorkspaceResearchTool({
        runWorkspaceAgent: async () => ({ sources: [], memos: [], messages: [], substeps: [] }) as never,
      }),
      createWebSearchTool({ tavilyApiKey: "tvly-test" }),
      createReadUrlTool(),
    ]
    const prompt = buildSystemPrompt(persona, scratchpadContext, null, undefined, undefined, null, tools)

    expect(prompt).toContain("## Workspace Research")
    expect(prompt).toContain("## Web Search")
    expect(prompt).toContain("## Reading URLs")
    expect(prompt.indexOf("## Workspace Research")).toBeLessThan(prompt.indexOf("## Web Search"))
    expect(prompt.indexOf("## Web Search")).toBeLessThan(prompt.indexOf("## Reading URLs"))
    // The scratchpad context section references workspace_research only when
    // the tool is actually wired (derived from the toolset, not a flag).
    expect(prompt).toContain("You can use the `workspace_research` tool")
  })

  test("web search recency guidance references tool metadata when the tool has no invocation time", () => {
    const prompt = buildSystemPrompt(persona, scratchpadContext, null, undefined, undefined, null, [
      createWebSearchTool({ tavilyApiKey: "tvly-test" }),
    ])

    expect(prompt).toContain("## Web Search")
    expect(prompt).toContain("ground recency in web_search tool metadata")
    expect(prompt).not.toContain(
      "ground your search and answer against the Current Time section; do not mix stale search results"
    )
  })

  test("web search recency guidance references Current Time when the tool is temporally grounded", () => {
    const prompt = buildSystemPrompt(
      persona,
      {
        ...scratchpadContext,
        temporal: {
          currentTime: "2026-11-15T10:00:00.000Z",
          timezone: "UTC",
          utcOffset: "UTC+0",
          dateFormat: "YYYY-MM-DD",
          timeFormat: "24h",
        },
      },
      null,
      undefined,
      undefined,
      null,
      [createWebSearchTool({ tavilyApiKey: "tvly-test", currentTime: "2026-11-15T10:00:00.000Z", timezone: "UTC" })]
    )

    expect(prompt).toContain(
      "ground your search and answer against the Current Time section; do not mix stale search results"
    )
  })
})
