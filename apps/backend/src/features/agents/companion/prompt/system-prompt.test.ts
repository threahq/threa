import { describe, expect, test } from "bun:test"
import { StreamTypes } from "@threa/types"
import { createReadUrlTool, createWebSearchTool } from "@threa/agent-runtime"
import type { Persona } from "../../persona-repository"
import type { StreamContext } from "../../context-builder"
import { createWorkspaceResearchTool } from "../../tools"
import {
  buildSystemPrompt,
  buildResponseStyleSection,
  joinSystemPrompt,
  type SystemPromptInputs,
} from "./system-prompt"

/** The builder returns a prompt split at its cache boundary; these assertions
 * are about the assembled prompt, so rejoin it. */
const buildJoinedPrompt = (inputs: SystemPromptInputs) => joinSystemPrompt(buildSystemPrompt(inputs))

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
    const prompt = buildJoinedPrompt({
      persona,
      context: scratchpadContext,
      scratchpadCustomPrompt: "Be concise and prioritize concrete next steps.",
    })

    expect(prompt).toContain("Base system prompt\n\n## Scratchpad Custom Instructions")
    expect(prompt).toContain("Be concise and prioritize concrete next steps.")
    expect(prompt.indexOf("## Scratchpad Custom Instructions")).toBeLessThan(prompt.indexOf("## Context"))
  })

  test("omits the custom instruction section when no scratchpad prompt exists", () => {
    const prompt = buildJoinedPrompt({ persona, context: scratchpadContext, scratchpadCustomPrompt: null })

    expect(prompt).not.toContain("## Scratchpad Custom Instructions")
  })

  test("tool sections come from the ACTUAL toolset — no tools means no tool prose", () => {
    const prompt = buildJoinedPrompt({
      persona,
      context: scratchpadContext,
      scratchpadCustomPrompt: null,
      rollingConversationSummary: null,
      tools: [],
    })

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
    const prompt = buildJoinedPrompt({
      persona,
      context: scratchpadContext,
      scratchpadCustomPrompt: null,
      rollingConversationSummary: null,
      tools,
    })

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
    const prompt = buildJoinedPrompt({
      persona,
      context: scratchpadContext,
      scratchpadCustomPrompt: null,
      rollingConversationSummary: null,
      tools: [createWebSearchTool({ tavilyApiKey: "tvly-test" })],
    })

    expect(prompt).toContain("## Web Search")
    expect(prompt).toContain("ground recency in web_search tool metadata")
    expect(prompt).not.toContain(
      "ground your search and answer against the Current Time section; do not mix stale search results"
    )
  })

  test("injects the Current Topic highlight before Conversation Memory when a topic is provided", () => {
    const prompt = buildJoinedPrompt({
      persona,
      context: scratchpadContext,
      scratchpadCustomPrompt: null,
      rollingConversationSummary: "Older turns, summarized.",
      tools: [],
      conversationTopic: "Designing the CSV export pipeline",
    })

    expect(prompt).toContain("## Current Topic")
    expect(prompt).toContain("The conversation is currently focused on: Designing the CSV export pipeline")
    expect(prompt.indexOf("## Current Topic")).toBeLessThan(prompt.indexOf("## Conversation Memory"))
  })

  test("omits the Current Topic section when no topic is provided", () => {
    const provided = buildJoinedPrompt({
      persona,
      context: scratchpadContext,
      scratchpadCustomPrompt: null,
      rollingConversationSummary: null,
      tools: [],
      conversationTopic: null,
    })
    const blank = buildJoinedPrompt({
      persona,
      context: scratchpadContext,
      scratchpadCustomPrompt: null,
      rollingConversationSummary: null,
      tools: [],
      conversationTopic: "   ",
    })

    expect(provided).not.toContain("## Current Topic")
    expect(blank).not.toContain("## Current Topic")
  })

  test("injects the spawned-from discussion block before Conversation Memory when context is provided", () => {
    const prompt = buildJoinedPrompt({
      persona,
      context: scratchpadContext,
      scratchpadCustomPrompt: null,
      rollingConversationSummary: "Older turns, summarized.",
      tools: [],
      conversationTopic: null,
      spawnedFromContext: "Topic: Migration timeout\n\nAlice (10:30): The migration keeps timing out",
    })

    expect(prompt).toContain("## Discussion This Thread Was Spawned From")
    expect(prompt).toContain("Alice (10:30): The migration keeps timing out")
    expect(prompt.indexOf("## Discussion This Thread Was Spawned From")).toBeLessThan(
      prompt.indexOf("## Conversation Memory")
    )
  })

  test("omits the spawned-from discussion block when no context is provided", () => {
    const provided = buildJoinedPrompt({
      persona,
      context: scratchpadContext,
      scratchpadCustomPrompt: null,
      rollingConversationSummary: null,
      tools: [],
      conversationTopic: null,
      spawnedFromContext: null,
    })
    const blank = buildJoinedPrompt({
      persona,
      context: scratchpadContext,
      scratchpadCustomPrompt: null,
      rollingConversationSummary: null,
      tools: [],
      conversationTopic: null,
      spawnedFromContext: "   ",
    })

    expect(provided).not.toContain("## Discussion This Thread Was Spawned From")
    expect(blank).not.toContain("## Discussion This Thread Was Spawned From")
  })

  test("injects the scheduled-follow-up section when the turn is a fired follow-up", () => {
    const prompt = buildJoinedPrompt({
      persona,
      context: {
        ...scratchpadContext,
        temporal: {
          currentTime: "2026-07-03T09:00:00.000Z",
          timezone: "UTC",
          utcOffset: "UTC+0",
          dateFormat: "YYYY-MM-DD",
          timeFormat: "24h",
        },
      },
      scratchpadCustomPrompt: null,
      purpose: { kind: "follow_up", followUpId: "agfu_01" },
      rollingConversationSummary: null,
      tools: [],
      conversationTopic: null,
      spawnedFromContext: null,
      followUp: { note: "check whether the deploy went out", scheduledFor: new Date("2026-07-03T09:00:00.000Z") },
    })

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
    const provided = buildJoinedPrompt({
      persona,
      context: scratchpadContext,
      scratchpadCustomPrompt: null,
      rollingConversationSummary: null,
      tools: [],
      conversationTopic: null,
      spawnedFromContext: null,
    })
    const explicitNull = buildJoinedPrompt({
      persona,
      context: scratchpadContext,
      scratchpadCustomPrompt: null,
      rollingConversationSummary: null,
      tools: [],
      conversationTopic: null,
      spawnedFromContext: null,
      followUp: null,
    })

    expect(provided).not.toContain("## Scheduled follow-up firing now")
    expect(explicitNull).not.toContain("## Scheduled follow-up firing now")
  })

  test("injects the Previous sessions block when episode summaries are provided", () => {
    const prompt = buildJoinedPrompt({
      persona,
      context: scratchpadContext,
      scratchpadCustomPrompt: null,
      rollingConversationSummary: null,
      tools: [],
      conversationTopic: null,
      spawnedFromContext: null,
      followUp: null,
      previousSessions:
        "## Previous sessions\n\nSummaries of your earlier work sessions in this stream, oldest first.\n\n- [2026-06-10T10:00:02.000Z] Concluded deploys happen Fridays only.",
    })

    expect(prompt).toContain("## Previous sessions")
    expect(prompt).toContain("Concluded deploys happen Fridays only.")
  })

  test("omits the Previous sessions block when none are provided", () => {
    const provided = buildJoinedPrompt({
      persona,
      context: scratchpadContext,
      scratchpadCustomPrompt: null,
      rollingConversationSummary: null,
      tools: [],
      conversationTopic: null,
      spawnedFromContext: null,
      followUp: null,
    })
    const blank = buildJoinedPrompt({
      persona,
      context: scratchpadContext,
      scratchpadCustomPrompt: null,
      rollingConversationSummary: null,
      tools: [],
      conversationTopic: null,
      spawnedFromContext: null,
      followUp: null,
      previousSessions: "   ",
    })

    expect(provided).not.toContain("## Previous sessions")
    expect(blank).not.toContain("## Previous sessions")
  })

  test("injects the mention invocation section, naming the mentioner, for a mention turn", () => {
    const prompt = buildJoinedPrompt({
      persona,
      context: scratchpadContext,
      scratchpadCustomPrompt: null,
      purpose: { kind: "mention" },
      mentionerName: "Kris",
    })

    expect(prompt).toContain("## Invocation Context")
    expect(prompt).toContain("You were explicitly @mentioned by **Kris**")
    expect(prompt).toContain("Your reply must directly answer that mention message.")
    expect(prompt).toContain("never let them displace the question you were asked")
  })

  test("omits the mention invocation section for a catch-up turn", () => {
    const prompt = buildJoinedPrompt({
      persona,
      context: scratchpadContext,
      scratchpadCustomPrompt: null,
      purpose: { kind: "catch_up" },
    })

    expect(prompt).not.toContain("## Invocation Context")
  })

  test("injects the supersede reconciliation section last for a supersede rerun", () => {
    const prompt = buildJoinedPrompt({
      persona,
      context: scratchpadContext,
      scratchpadCustomPrompt: null,
      purpose: {
        kind: "supersede_rerun",
        supersedesSessionId: "agsess_prev",
        rerunContext: {
          cause: "invoking_message_edited",
          editedMessageId: "msg_edited",
          editedMessageBefore: "book me a flight",
          editedMessageAfter: "book me a train",
        },
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
    const prompt = buildJoinedPrompt({
      persona,
      context: scratchpadContext,
      scratchpadCustomPrompt: null,
      purpose: { kind: "catch_up" },
    })

    expect(prompt).not.toContain("## Superseded Session Reconciliation")
  })

  test("web search recency guidance references Current Time when the tool is temporally grounded", () => {
    const prompt = buildJoinedPrompt({
      persona,
      context: {
        ...scratchpadContext,
        temporal: {
          currentTime: "2026-11-15T10:00:00.000Z",
          timezone: "UTC",
          utcOffset: "UTC+0",
          dateFormat: "YYYY-MM-DD",
          timeFormat: "24h",
        },
      },
      scratchpadCustomPrompt: null,
      rollingConversationSummary: null,
      tools: [
        createWebSearchTool({ tavilyApiKey: "tvly-test", currentTime: "2026-11-15T10:00:00.000Z", timezone: "UTC" }),
      ],
    })

    expect(prompt).toContain(
      "ground your search and answer against the Current Time section; do not mix stale search results"
    )
  })

  test("injects the Stream Brief early — before the stream context — when the stream carries one (roadmap 4.1)", () => {
    const prompt = buildJoinedPrompt({
      persona,
      context: scratchpadContext,
      scratchpadCustomPrompt: null,
      rollingConversationSummary: null,
      tools: [],
      conversationTopic: null,
      spawnedFromContext: null,
      previousSessions: null,
      streamBrief: "- Goal: ship the CSV export by Friday\n- Prefer Bun over Node",
    })

    expect(prompt).toContain("## Stream Brief")
    expect(prompt).toContain("- Goal: ship the CSV export by Friday")
    expect(prompt.indexOf("## Stream Brief")).toBeLessThan(prompt.indexOf("## Context"))
  })

  const knowledge = [
    {
      attachmentId: "att_1",
      filename: "runbook.md",
      position: 0,
      fullText: "RUNBOOK CONTENT",
      summary: null,
      processingStatus: "completed" as const,
      hasExtraction: true,
    },
    {
      attachmentId: "att_2",
      filename: "faq.txt",
      position: 1,
      fullText: null,
      summary: "FAQ SUMMARY",
      processingStatus: "completed" as const,
      hasExtraction: true,
    },
  ]

  test("injects the persona ## Knowledge block after the persona prompt and before the stream context", () => {
    const prompt = buildJoinedPrompt({
      persona,
      context: scratchpadContext,
      scratchpadCustomPrompt: null,
      rollingConversationSummary: null,
      tools: [],
      conversationTopic: null,
      spawnedFromContext: null,
      followUp: null,
      previousSessions: null,
      streamBrief: null,
      personaKnowledge: knowledge,
    })

    expect(prompt).toContain("## Knowledge")
    expect(prompt).toContain("### runbook.md\n\nRUNBOOK CONTENT")
    expect(prompt).toContain("### faq.txt\n\nFAQ SUMMARY")
    // Files render in position order.
    expect(prompt.indexOf("### runbook.md")).toBeLessThan(prompt.indexOf("### faq.txt"))
    // The block sits in the stable prefix: after the base persona prompt, before
    // the stream context section.
    expect(prompt.indexOf("Base system prompt")).toBeLessThan(prompt.indexOf("## Knowledge"))
    expect(prompt.indexOf("## Knowledge")).toBeLessThan(prompt.indexOf("## Context"))
  })

  test("no persona attachments → byte-identical to the pre-feature prompt", () => {
    const base = buildJoinedPrompt({
      persona,
      context: scratchpadContext,
      scratchpadCustomPrompt: null,
      rollingConversationSummary: null,
      tools: [],
    })
    const withUndefined = buildJoinedPrompt({
      persona,
      context: scratchpadContext,
      scratchpadCustomPrompt: null,
      rollingConversationSummary: null,
      tools: [],
      conversationTopic: null,
      spawnedFromContext: null,
      followUp: null,
      previousSessions: null,
      streamBrief: null,
    })
    const withEmpty = buildJoinedPrompt({
      persona,
      context: scratchpadContext,
      scratchpadCustomPrompt: null,
      rollingConversationSummary: null,
      tools: [],
      conversationTopic: null,
      spawnedFromContext: null,
      followUp: null,
      previousSessions: null,
      streamBrief: null,
      personaKnowledge: [],
    })
    const withNull = buildJoinedPrompt({
      persona,
      context: scratchpadContext,
      scratchpadCustomPrompt: null,
      rollingConversationSummary: null,
      tools: [],
      conversationTopic: null,
      spawnedFromContext: null,
      followUp: null,
      previousSessions: null,
      streamBrief: null,
      personaKnowledge: null,
    })

    expect(withUndefined).toBe(base)
    expect(withEmpty).toBe(base)
    expect(withNull).toBe(base)
    expect(base).not.toContain("## Knowledge")
  })

  test("omits the Stream Brief section when the stream has no brief (or a blank one)", () => {
    const absent = buildJoinedPrompt({
      persona,
      context: scratchpadContext,
      scratchpadCustomPrompt: null,
      rollingConversationSummary: null,
      tools: [],
    })
    const blank = buildJoinedPrompt({
      persona,
      context: scratchpadContext,
      scratchpadCustomPrompt: null,
      rollingConversationSummary: null,
      tools: [],
      conversationTopic: null,
      spawnedFromContext: null,
      previousSessions: null,
      streamBrief: "   ",
    })

    expect(absent).not.toContain("## Stream Brief")
    expect(blank).not.toContain("## Stream Brief")
  })

  const DEFAULT_STYLE =
    "Be brief. Default to 1–3 sentences. Match the depth to what was asked — a simple question gets a simple answer. Only go longer when the topic genuinely requires it (step-by-step instructions, complex analysis the user requested, etc.). Avoid preamble, filler, and restating what the user said. Be friendly and warm in tone, but don't pad with extra words."

  test("styleSlots absent → Response Style section is the verbatim pre-slot default", () => {
    const prompt = buildJoinedPrompt({
      persona,
      context: scratchpadContext,
      scratchpadCustomPrompt: null,
      rollingConversationSummary: null,
      tools: [],
    })
    expect(prompt).toContain(`## Response Style\n\n${DEFAULT_STYLE}`)
  })

  test("a set styleSlots preset fragment lands in the Response Style section", () => {
    const prompt = buildJoinedPrompt({
      persona,
      context: scratchpadContext,
      scratchpadCustomPrompt: null,
      rollingConversationSummary: null,
      tools: [],
      conversationTopic: null,
      spawnedFromContext: null,
      previousSessions: null,
      streamBrief: null,
      styleSlots: { tone: "TONE_FRAGMENT_MARKER", brevity: "BREVITY_FRAGMENT_MARKER" },
    })
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

describe("buildSystemPrompt cache split", () => {
  const temporalContext: StreamContext = {
    ...scratchpadContext,
    temporal: {
      currentTime: "2026-07-03T09:00:00.000Z",
      timezone: "UTC",
      utcOffset: "UTC+0",
      dateFormat: "YYYY-MM-DD",
      timeFormat: "24h",
    },
  }

  // Tool definitions render ahead of the system prompt in the cached prefix, so
  // anything re-derived per turn has to sit outside the cached half or the
  // prefix changes every turn and nothing is ever reused.
  // Third instance of this bug class in review, so the guard asserts the general
  // invariant rather than any one section: two turns of the same conversation
  // must produce a byte-identical stable half whatever drifts between them.
  test("produces a byte-identical stable half across differing topics and summaries", () => {
    const a = buildSystemPrompt({
      persona,
      context: temporalContext,
      scratchpadCustomPrompt: null,
      purpose: { kind: "catch_up" },
      rollingConversationSummary: "summary A",
      tools: [],
      conversationTopic: "topic A",
    })
    const b = buildSystemPrompt({
      persona,
      context: temporalContext,
      scratchpadCustomPrompt: null,
      purpose: { kind: "catch_up" },
      rollingConversationSummary: "summary B",
      tools: [],
      conversationTopic: "topic B",
    })

    expect(a.stable).toBe(b.stable)
    // …and both are still present, below the breakpoint.
    expect(a.volatile).toContain("topic A")
    expect(a.volatile).toContain("summary A")
    expect(b.volatile).toContain("topic B")
  })

  test("keeps a shrinking cross-surface stitch out of the cacheable half", () => {
    const withStitch = buildSystemPrompt({
      persona,
      context: temporalContext,
      scratchpadCustomPrompt: null,
      purpose: { kind: "catch_up" },
      rollingConversationSummary: null,
      tools: [],
      conversationTopic: null,
      spawnedFromContext: "PARENT DISCUSSION",
    })
    const without = buildSystemPrompt({
      persona,
      context: temporalContext,
      scratchpadCustomPrompt: null,
      purpose: { kind: "catch_up" },
    })

    expect(withStitch.stable).toBe(without.stable)
    expect(withStitch.volatile).toContain("PARENT DISCUSSION")
  })

  test("keeps temporal grounding out of the cacheable half", () => {
    const split = buildSystemPrompt({ persona, context: temporalContext, scratchpadCustomPrompt: null })

    expect(split.stable).not.toContain("## Current Time")
    expect(split.volatile).toContain("## Current Time")
  })

  // The invariant the whole split rests on: two turns in the same conversation
  // must produce a byte-identical stable half, whatever kind of turn each is.
  // Anything per-turn that drifts above the split silently restores the
  // cross-turn cache miss — no test failure, no error, just a 0% hit rate.
  test("produces a byte-identical stable half across differing turn purposes", () => {
    const mention = buildSystemPrompt({
      persona,
      context: temporalContext,
      scratchpadCustomPrompt: null,
      purpose: { kind: "mention" },
      mentionerName: "Kris",
    })
    const otherMentioner = buildSystemPrompt({
      persona,
      context: temporalContext,
      scratchpadCustomPrompt: null,
      purpose: { kind: "mention" },
      mentionerName: "Sam",
    })
    const catchUp = buildSystemPrompt({
      persona,
      context: temporalContext,
      scratchpadCustomPrompt: null,
      purpose: { kind: "catch_up" },
    })

    expect(mention.stable).toBe(catchUp.stable)
    expect(otherMentioner.stable).toBe(catchUp.stable)
    // …and the per-turn detail is still present, just below the breakpoint.
    expect(mention.volatile).toContain("Kris")
    expect(otherMentioner.volatile).toContain("Sam")
  })

  test("keeps a fired follow-up's note and time out of the stable half", () => {
    const followUp = buildSystemPrompt({
      persona,
      context: temporalContext,
      scratchpadCustomPrompt: null,
      purpose: { kind: "follow_up", followUpId: "fup_test" },
      rollingConversationSummary: null,
      tools: [],
      conversationTopic: null,
      spawnedFromContext: null,
      followUp: {
        note: "revisit the rollback plan",
        scheduledFor: new Date("2026-07-04T09:00:00.000Z"),
      },
    })
    const catchUp = buildSystemPrompt({
      persona,
      context: temporalContext,
      scratchpadCustomPrompt: null,
      purpose: { kind: "catch_up" },
    })

    expect(followUp.stable).toBe(catchUp.stable)
    expect(followUp.volatile).toContain("revisit the rollback plan")
  })

  test("rejoins to exactly the prompt a single-string caller would have got", () => {
    const split = buildSystemPrompt({ persona, context: temporalContext, scratchpadCustomPrompt: "Be concise." })

    expect(joinSystemPrompt(split)).toBe(split.stable + split.volatile)
    expect(joinSystemPrompt(split)).toContain("## Current Time")
  })
})
