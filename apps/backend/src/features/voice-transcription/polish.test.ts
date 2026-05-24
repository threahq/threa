import { describe, expect, it, mock } from "bun:test"
import { createPolishTranscript, POLISH_MODEL } from "./polish"
import type { AI } from "../../lib/ai/ai"

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
      workspaceId: "ws_1",
      userId: "user_1",
      sessionId: "voicesess_1",
    })

    expect(out).toBe("Hello, world.")
    const call = generateText.mock.calls[0][0]
    expect(call.model).toBe(POLISH_MODEL)
    expect(call.telemetry?.functionId).toBe("voice-transcript-polish")
    expect(call.context).toMatchObject({ workspaceId: "ws_1", userId: "user_1", origin: "user" })
  })

  it("sends the full cumulative transcript in the user message", async () => {
    const generateText = mock(async (_args: GenerateTextArgs) => textResult("Polished.") as never)
    const polish = createPolishTranscript({ ai: fakeAI(generateText) })

    await polish({
      rawTranscript: "one two three and four",
      workspaceId: "ws_1",
      userId: "user_1",
      sessionId: "voicesess_1",
    })

    const call = generateText.mock.calls[0][0]
    const userMessage = call.messages.find((m: { role: string }) => m.role === "user")
    expect(typeof userMessage?.content).toBe("string")
    expect(userMessage?.content).toContain("one two three and four")
  })

  it("returns the raw text when the model call rejects (never throws)", async () => {
    const generateText = mock(async (_args: GenerateTextArgs) => {
      throw new Error("upstream down")
    })
    const polish = createPolishTranscript({ ai: fakeAI(generateText) })

    const out = await polish({
      rawTranscript: "hello world",
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
      workspaceId: "ws_1",
      userId: "user_1",
      sessionId: "voicesess_1",
    })

    expect(out).toBe("   ")
    expect(generateText).not.toHaveBeenCalled()
  })
})
