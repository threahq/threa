import { describe, expect, it, mock } from "bun:test"
import { createPolishTranscript, scrubDashes } from "./polish"
import { POLISH_MODEL } from "./config"
import type { AI } from "@threa/agent-runtime"

type GenerateTextArgs = Parameters<AI["generateText"]>[0]

function fakeAI(generateText: AI["generateText"]) {
  return { generateText } as unknown as AI
}

function textResult(value: string) {
  return { value, response: undefined as never, usage: {} }
}

describe("createPolishTranscript", () => {
  it("calls the small polish model with the raw transcript and returns the trimmed polished value", async () => {
    const generateText = mock(async (_args: GenerateTextArgs) => textResult("  Hello, world.  ") as never)
    const polish = createPolishTranscript({ ai: fakeAI(generateText) })

    const out = await polish({
      rawTranscript: "hello world",
      level: "opinionated",
      workspaceId: "ws_1",
      userId: "user_1",
      sessionId: "voicesess_1",
    })

    expect(out).toBe("Hello, world.")
    const call = generateText.mock.calls[0][0]
    expect(call.model).toBe(POLISH_MODEL)
    expect(call.telemetry?.functionId).toBe("voice-transcript-polish")
    expect(call.telemetry?.metadata).toMatchObject({ level: "opinionated" })
    expect(call.context).toMatchObject({ workspaceId: "ws_1", userId: "user_1", origin: "user" })
  })

  it("sends the full cumulative transcript in the user message", async () => {
    const generateText = mock(async (_args: GenerateTextArgs) => textResult("Polished.") as never)
    const polish = createPolishTranscript({ ai: fakeAI(generateText) })

    await polish({
      rawTranscript: "one two three and four",
      level: "opinionated",
      workspaceId: "ws_1",
      userId: "user_1",
      sessionId: "voicesess_1",
    })

    const call = generateText.mock.calls[0][0]
    const userMessage = call.messages.find((m: { role: string }) => m.role === "user")
    expect(typeof userMessage?.content).toBe("string")
    expect(userMessage?.content).toContain("one two three and four")
  })

  it("uses the minor-cleanup system prompt for level=minor", async () => {
    const generateText = mock(async (_args: GenerateTextArgs) => textResult("clean") as never)
    const polish = createPolishTranscript({ ai: fakeAI(generateText) })

    await polish({
      rawTranscript: "raw",
      level: "minor",
      workspaceId: "ws_1",
      userId: "user_1",
      sessionId: "voicesess_1",
    })

    const sys = generateText.mock.calls[0][0].messages.find((m: { role: string }) => m.role === "system")
    const content = sys?.content as string
    // Minor prompt keeps filler and self-corrections intact; opinionated drops them.
    expect(content).toContain("ONLY minor fixes")
    expect(content).toContain("Do NOT remove filler")
  })

  it("uses the opinionated system prompt for level=opinionated", async () => {
    const generateText = mock(async (_args: GenerateTextArgs) => textResult("clean") as never)
    const polish = createPolishTranscript({ ai: fakeAI(generateText) })

    await polish({
      rawTranscript: "raw",
      level: "opinionated",
      workspaceId: "ws_1",
      userId: "user_1",
      sessionId: "voicesess_1",
    })

    const sys = generateText.mock.calls[0][0].messages.find((m: { role: string }) => m.role === "system")
    const content = sys?.content as string
    expect(content).toContain("OPINIONATED corrections")
    expect(content).toContain("self-corrections")
  })

  it("tells the model to apply rules in the speaker's language (both prompts, not English-only)", async () => {
    // INV-54: don't make semantic decisions with English-only heuristics. The
    // examples in both prompts are English; this note is what tells the model
    // to transpose them rather than treating "uh"/"um"/"colon" as literals.
    const generateText = mock(async (_args: GenerateTextArgs) => textResult("ok") as never)
    const polish = createPolishTranscript({ ai: fakeAI(generateText) })

    for (const level of ["minor", "opinionated"] as const) {
      generateText.mockClear()
      await polish({
        rawTranscript: "raw",
        level,
        workspaceId: "ws_1",
        userId: "user_1",
        sessionId: "voicesess_1",
      })
      const sys = generateText.mock.calls[0][0].messages.find((m: { role: string }) => m.role === "system")
      const content = sys?.content as string
      expect(content).toContain("detect the language")
      expect(content).toContain("Never translate the transcript")
    }
  })

  it("bans em-dashes in both prompts (belt) and scrubs any that slip through (suspenders)", async () => {
    const generateText = mock(async (_args: GenerateTextArgs) => textResult("here's what I'm thinking — pie") as never)
    const polish = createPolishTranscript({ ai: fakeAI(generateText) })

    const out = await polish({
      rawTranscript: "raw",
      level: "opinionated",
      workspaceId: "ws_1",
      userId: "user_1",
      sessionId: "voicesess_1",
    })

    expect(out).not.toContain("—")
    expect(out).not.toContain("–")
    expect(out).toBe("here's what I'm thinking: pie")

    const sys = generateText.mock.calls[0][0].messages.find((m: { role: string }) => m.role === "system")
    expect(sys?.content).toContain("em dashes")
  })

  it("returns the raw text when the model call rejects (never throws)", async () => {
    const generateText = mock(async (_args: GenerateTextArgs) => {
      throw new Error("upstream down")
    })
    const polish = createPolishTranscript({ ai: fakeAI(generateText) })

    const out = await polish({
      rawTranscript: "hello world",
      level: "opinionated",
      workspaceId: "ws_1",
      userId: "user_1",
      sessionId: "voicesess_1",
    })

    expect(out).toBe("hello world")
  })

  it("returns the raw text unchanged when the model returns an empty string", async () => {
    const generateText = mock(async (_args: GenerateTextArgs) => textResult("   ") as never)
    const polish = createPolishTranscript({ ai: fakeAI(generateText) })

    const out = await polish({
      rawTranscript: "non empty",
      level: "opinionated",
      workspaceId: "ws_1",
      userId: "user_1",
      sessionId: "voicesess_1",
    })

    expect(out).toBe("non empty")
  })

  it("skips the model entirely for whitespace-only input", async () => {
    const generateText = mock(async (_args: GenerateTextArgs) => textResult("should not be called") as never)
    const polish = createPolishTranscript({ ai: fakeAI(generateText) })

    const out = await polish({
      rawTranscript: "   ",
      level: "opinionated",
      workspaceId: "ws_1",
      userId: "user_1",
      sessionId: "voicesess_1",
    })

    expect(out).toBe("   ")
    expect(generateText).not.toHaveBeenCalled()
  })
})

describe("scrubDashes", () => {
  it("rewrites ' — ' between clauses to ': '", () => {
    expect(scrubDashes("here's what I'm thinking — pie for dinner")).toBe("here's what I'm thinking: pie for dinner")
  })

  it("rewrites tight 'word—word' to a comma", () => {
    expect(scrubDashes("nine—eight")).toBe("nine, eight")
  })

  it("handles en dashes the same way", () => {
    expect(scrubDashes("a – b")).toBe("a: b")
    expect(scrubDashes("a–b")).toBe("a, b")
  })

  it("leaves ASCII hyphens alone (legitimate compounds)", () => {
    expect(scrubDashes("voice-memo nine-to-five")).toBe("voice-memo nine-to-five")
  })
})
