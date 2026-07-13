import { describe, expect, test } from "bun:test"
import { StreamTypes } from "@threa/types"
import { createReadUrlTool, createWebSearchTool } from "@threa/agent-runtime"
import type { Persona } from "../../persona-repository"
import type { StreamContext } from "../../context-builder"
import { createWorkspaceResearchTool } from "../../tools"
import { buildSystemPrompt, buildResponseStyleSection } from "./system-prompt"

const persona: Persona = {
  id: "persona_ariadne",
  workspaceId: null,
  slug: "ariadne",
  name: "Ariadne",
  description: null,
  avatarEmoji: null,
  avatarUrl: null,
  systemPrompt: "Base system prompt",
  model: "openai/gpt-5.4",
  escalationModel: null,
  temperature: 0.2,
  maxTokens: 1000,
  enabledTools: null,
  tonePreset: null,
  brevityPreset: null,
  tonePrompt: null,
  brevityPrompt: null,
  managedBy: "system",
  ownerUserId: null,
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

  test("injects the Current Topic highlight before Conversation Memory when a topic is provided", () => {
    const prompt = buildSystemPrompt(
      persona,
      scratchpadContext,
      null,
      undefined,
      undefined,
      "Older turns, summarized.",
      [],
      "Designing the CSV export pipeline"
    )

    expect(prompt).toContain("## Current Topic")
    expect(prompt).toContain("The conversation is currently focused on: Designing the CSV export pipeline")
    expect(prompt.indexOf("## Current Topic")).toBeLessThan(prompt.indexOf("## Conversation Memory"))
  })

  test("omits the Current Topic section when no topic is provided", () => {
    const provided = buildSystemPrompt(persona, scratchpadContext, null, undefined, undefined, null, [], null)
    const blank = buildSystemPrompt(persona, scratchpadContext, null, undefined, undefined, null, [], "   ")

    expect(provided).not.toContain("## Current Topic")
    expect(blank).not.toContain("## Current Topic")
  })

  test("injects the spawned-from discussion block before Conversation Memory when context is provided", () => {
    const prompt = buildSystemPrompt(
      persona,
      scratchpadContext,
      null,
      undefined,
      undefined,
      "Older turns, summarized.",
      [],
      null,
      "Topic: Migration timeout\n\nAlice (10:30): The migration keeps timing out"
    )

    expect(prompt).toContain("## Discussion This Thread Was Spawned From")
    expect(prompt).toContain("Alice (10:30): The migration keeps timing out")
    expect(prompt.indexOf("## Discussion This Thread Was Spawned From")).toBeLessThan(
      prompt.indexOf("## Conversation Memory")
    )
  })

  test("omits the spawned-from discussion block when no context is provided", () => {
    const provided = buildSystemPrompt(persona, scratchpadContext, null, undefined, undefined, null, [], null, null)
    const blank = buildSystemPrompt(persona, scratchpadContext, null, undefined, undefined, null, [], null, "   ")

    expect(provided).not.toContain("## Discussion This Thread Was Spawned From")
    expect(blank).not.toContain("## Discussion This Thread Was Spawned From")
  })

  test("injects the scheduled-follow-up section when the turn is a fired follow-up", () => {
    const prompt = buildSystemPrompt(
      persona,
      {
        ...scratchpadContext,
        temporal: {
          currentTime: "2026-07-03T09:00:00.000Z",
          timezone: "UTC",
          utcOffset: "UTC+0",
          dateFormat: "YYYY-MM-DD",
          timeFormat: "24h",
        },
      },
      null,
      { kind: "follow_up", followUpId: "agfu_01" },
      undefined,
      null,
      [],
      null,
      null,
      { note: "check whether the deploy went out", scheduledFor: new Date("2026-07-03T09:00:00.000Z") }
    )

    expect(prompt).toContain("## Scheduled follow-up firing now")
    // Carries the note and the scheduled time rendered in the user's timezone.
    expect(prompt).toContain("check whether the deploy went out")
    expect(prompt).toContain("2026-07-03 09:00")
    // The two staging-bug guards: act now (don't decline) and don't re-schedule.
    expect(prompt).toContain("This IS that reminder firing")
    expect(prompt).toContain("Do NOT schedule another follow-up")
    expect(prompt).toContain("keep_response")
  })

  test("omits the scheduled-follow-up section for a normal turn", () => {
    const provided = buildSystemPrompt(persona, scratchpadContext, null, undefined, undefined, null, [], null, null)
    const explicitNull = buildSystemPrompt(
      persona,
      scratchpadContext,
      null,
      undefined,
      undefined,
      null,
      [],
      null,
      null,
      null
    )

    expect(provided).not.toContain("## Scheduled follow-up firing now")
    expect(explicitNull).not.toContain("## Scheduled follow-up firing now")
  })

  test("injects the Previous sessions block when episode summaries are provided", () => {
    const prompt = buildSystemPrompt(
      persona,
      scratchpadContext,
      null,
      undefined,
      undefined,
      null,
      [],
      null,
      null,
      null,
      "## Previous sessions\n\nSummaries of your earlier work sessions in this stream, oldest first.\n\n- [2026-06-10T10:00:02.000Z] Concluded deploys happen Fridays only."
    )

    expect(prompt).toContain("## Previous sessions")
    expect(prompt).toContain("Concluded deploys happen Fridays only.")
  })

  test("omits the Previous sessions block when none are provided", () => {
    const provided = buildSystemPrompt(
      persona,
      scratchpadContext,
      null,
      undefined,
      undefined,
      null,
      [],
      null,
      null,
      null
    )
    const blank = buildSystemPrompt(
      persona,
      scratchpadContext,
      null,
      undefined,
      undefined,
      null,
      [],
      null,
      null,
      null,
      "   "
    )

    expect(provided).not.toContain("## Previous sessions")
    expect(blank).not.toContain("## Previous sessions")
  })

  test("injects the mention invocation section, naming the mentioner, for a mention turn", () => {
    const prompt = buildSystemPrompt(persona, scratchpadContext, null, { kind: "mention" }, "Kris")

    expect(prompt).toContain("## Invocation Context")
    expect(prompt).toContain("You were explicitly @mentioned by **Kris**")
    expect(prompt).toContain("Your reply must directly answer that mention message.")
    expect(prompt).toContain("never let them displace the question you were asked")
  })

  test("omits the mention invocation section for a catch-up turn", () => {
    const prompt = buildSystemPrompt(persona, scratchpadContext, null, { kind: "catch_up" })

    expect(prompt).not.toContain("## Invocation Context")
  })

  test("injects the supersede reconciliation section last for a supersede rerun", () => {
    const prompt = buildSystemPrompt(persona, scratchpadContext, null, {
      kind: "supersede_rerun",
      supersedesSessionId: "agsess_prev",
      rerunContext: {
        cause: "invoking_message_edited",
        editedMessageId: "msg_edited",
        editedMessageBefore: "book me a flight",
        editedMessageAfter: "book me a train",
      },
    })

    expect(prompt).toContain("## Superseded Session Reconciliation")
    expect(prompt).toContain("Edited message ID: msg_edited")
    expect(prompt).toContain('After edit: "book me a train"')
    expect(prompt).toContain("exactly one of `keep_response` or `send_message`")
    // Reconciliation lands last so its final-decision directive is most salient.
    expect(prompt.indexOf("## Superseded Session Reconciliation")).toBeGreaterThan(prompt.indexOf("## Response Style"))
  })

  test("omits the supersede reconciliation section for a catch-up turn", () => {
    const prompt = buildSystemPrompt(persona, scratchpadContext, null, { kind: "catch_up" })

    expect(prompt).not.toContain("## Superseded Session Reconciliation")
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

  test("injects the Stream Brief early — before the stream context — when the stream carries one (roadmap 4.1)", () => {
    const prompt = buildSystemPrompt(
      persona,
      scratchpadContext,
      null,
      undefined,
      undefined,
      null,
      [],
      null,
      null,
      undefined,
      null,
      "- Goal: ship the CSV export by Friday\n- Prefer Bun over Node"
    )

    expect(prompt).toContain("## Stream Brief")
    expect(prompt).toContain("- Goal: ship the CSV export by Friday")
    expect(prompt.indexOf("## Stream Brief")).toBeLessThan(prompt.indexOf("## Context"))
  })

  test("omits the Stream Brief section when the stream has no brief (or a blank one)", () => {
    const absent = buildSystemPrompt(persona, scratchpadContext, null, undefined, undefined, null, [])
    const blank = buildSystemPrompt(
      persona,
      scratchpadContext,
      null,
      undefined,
      undefined,
      null,
      [],
      null,
      null,
      undefined,
      null,
      "   "
    )

    expect(absent).not.toContain("## Stream Brief")
    expect(blank).not.toContain("## Stream Brief")
  })

  const DEFAULT_STYLE =
    "Be brief. Default to 1–3 sentences. Match the depth to what was asked — a simple question gets a simple answer. Only go longer when the topic genuinely requires it (step-by-step instructions, complex analysis the user requested, etc.). Avoid preamble, filler, and restating what the user said. Be friendly and warm in tone, but don't pad with extra words."

  test("styleSlots absent → Response Style section is the verbatim pre-slot default", () => {
    const prompt = buildSystemPrompt(persona, scratchpadContext, null, undefined, undefined, null, [])
    expect(prompt).toContain(`## Response Style\n\n${DEFAULT_STYLE}`)
  })

  test("a set styleSlots preset fragment lands in the Response Style section", () => {
    const prompt = buildSystemPrompt(
      persona,
      scratchpadContext,
      null,
      undefined,
      undefined,
      null,
      [],
      null,
      null,
      undefined,
      null,
      null,
      { tone: "TONE_FRAGMENT_MARKER", brevity: "BREVITY_FRAGMENT_MARKER" }
    )
    // Both aspects replaced, brevity-then-tone, still inside the same section.
    expect(prompt).toContain("## Response Style\n\nBREVITY_FRAGMENT_MARKER TONE_FRAGMENT_MARKER")
    expect(prompt).not.toContain(DEFAULT_STYLE)
  })
})

describe("buildResponseStyleSection", () => {
  const DEFAULT_BREVITY =
    "Be brief. Default to 1–3 sentences. Match the depth to what was asked — a simple question gets a simple answer. Only go longer when the topic genuinely requires it (step-by-step instructions, complex analysis the user requested, etc.). Avoid preamble, filler, and restating what the user said."
  const DEFAULT_TONE = "Be friendly and warm in tone, but don't pad with extra words."

  test("no slots → both defaults, joined brevity-then-tone (byte-identical to the old block)", () => {
    expect(buildResponseStyleSection()).toBe(`\n\n## Response Style\n\n${DEFAULT_BREVITY} ${DEFAULT_TONE}`)
    expect(buildResponseStyleSection({})).toBe(`\n\n## Response Style\n\n${DEFAULT_BREVITY} ${DEFAULT_TONE}`)
  })

  test("tone set only → replaces tone, keeps default brevity text", () => {
    expect(buildResponseStyleSection({ tone: "Be gruff." })).toBe(
      `\n\n## Response Style\n\n${DEFAULT_BREVITY} Be gruff.`
    )
  })

  test("brevity set only → replaces brevity, keeps default tone text", () => {
    expect(buildResponseStyleSection({ brevity: "One word." })).toBe(
      `\n\n## Response Style\n\nOne word. ${DEFAULT_TONE}`
    )
  })

  test("blank/whitespace slot falls back to the default for that aspect", () => {
    expect(buildResponseStyleSection({ tone: "   ", brevity: "" })).toBe(
      `\n\n## Response Style\n\n${DEFAULT_BREVITY} ${DEFAULT_TONE}`
    )
  })
})
