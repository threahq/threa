import { describe, expect, it, mock } from "bun:test"
import type { LanguageModel } from "ai"
import {
  clampRollingSummary,
  foldRollingSummary,
  formatConversationMemoryForPrompt,
  ROLLING_SUMMARY_MAX_CHARS,
  type RollingSummaryMessage,
} from "./rolling-summary"
import type { AgentRuntimeAI } from "./agent-runtime"

const MODEL = {} as unknown as LanguageModel

function stubAI(text: string) {
  const generateTextWithTools = mock((_options: unknown) =>
    Promise.resolve({ text, toolCalls: [], response: { messages: [] } })
  )
  return { ai: { generateTextWithTools } as unknown as AgentRuntimeAI, generateTextWithTools }
}

function msg(sequence: bigint, authorLabel: string, content: string): RollingSummaryMessage {
  return { sequence, authorLabel, content }
}

describe("foldRollingSummary", () => {
  it("folds the dropped segment into the prior summary and returns the trimmed text", async () => {
    const { ai, generateTextWithTools } = stubAI("  Merged running memory.  ")
    const result = await foldRollingSummary({
      ai,
      model: MODEL,
      modelString: "openrouter:anthropic/claude-haiku-4.5",
      existingSummary: "Prior memory of the conversation.",
      newMessages: [msg(5n, "user:usr_1", "Let's switch the deploy to Friday.")],
      temperature: 0.1,
    })

    expect(result).toBe("Merged running memory.")
    const call = generateTextWithTools.mock.calls[0]?.[0] as { messages: { content: string }[]; temperature: number }
    // The prior summary and the dropped segment both reach the fold prompt, and
    // the per-message line carries the sequence the cursor advances over.
    expect(call.messages[0].content).toContain("Prior memory of the conversation.")
    expect(call.messages[0].content).toContain("[#5] user:usr_1 Let's switch the deploy to Friday.")
    expect(call.temperature).toBe(0.1)
  })

  it("treats an empty prior summary as a fresh start", async () => {
    const { ai, generateTextWithTools } = stubAI("First memory.")
    await foldRollingSummary({
      ai,
      model: MODEL,
      existingSummary: "",
      newMessages: [msg(1n, "user:usr_1", "Hello.")],
    })
    expect(
      (generateTextWithTools.mock.calls[0]?.[0] as { messages: { content: string }[] }).messages[0].content
    ).toContain("No prior summary.")
  })

  it("clamps an over-long fold result to the shared bound", async () => {
    const { ai } = stubAI("x".repeat(ROLLING_SUMMARY_MAX_CHARS + 500))
    const result = await foldRollingSummary({
      ai,
      model: MODEL,
      existingSummary: "",
      newMessages: [msg(1n, "user:usr_1", "long")],
    })
    expect(result.length).toBe(ROLLING_SUMMARY_MAX_CHARS)
  })
})

describe("clampRollingSummary", () => {
  it("trims and hard-caps to the shared bound", () => {
    expect(clampRollingSummary("  hi  ")).toBe("hi")
    expect(clampRollingSummary("y".repeat(ROLLING_SUMMARY_MAX_CHARS + 10)).length).toBe(ROLLING_SUMMARY_MAX_CHARS)
  })
})

describe("formatConversationMemoryForPrompt", () => {
  it("renders the `## Conversation Memory` block for a non-empty summary", () => {
    const block = formatConversationMemoryForPrompt("They agreed to ship Friday.")
    expect(block).not.toBeNull()
    expect(block).toContain("## Conversation Memory")
    expect(block).toContain("They agreed to ship Friday.")
  })

  it("returns null for an empty or whitespace summary (no block)", () => {
    expect(formatConversationMemoryForPrompt(null)).toBeNull()
    expect(formatConversationMemoryForPrompt("   ")).toBeNull()
  })
})
