import { describe, expect, it } from "vitest"
import type { LanguageModel } from "ai"
import type { RawChatFn, RawChatRequest, RawChatResult } from "../llm"
import { createEnclaveAI, type UsageAccumulator } from "./enclave-ai"

function stub(result: RawChatResult): { fn: RawChatFn; seen: RawChatRequest[] } {
  const seen: RawChatRequest[] = []
  return {
    seen,
    fn: async (req) => {
      seen.push(req)
      return result
    },
  }
}

const MODEL = "anthropic/claude-sonnet-4.6" as unknown as LanguageModel

describe("createEnclaveAI", () => {
  it("forwards modelString + converted messages and maps a text reply", async () => {
    const chat = stub({
      message: { content: "Paris." },
      model: "stub",
      usage: { prompt_tokens: 5, completion_tokens: 3 },
    })
    const usage: UsageAccumulator = { promptTokens: 0, completionTokens: 0, cost: 0 }
    const ai = createEnclaveAI(chat.fn, usage)

    const result = await ai.generateTextWithTools({
      model: MODEL,
      modelString: "anthropic/claude-sonnet-4.6",
      system: "sys",
      messages: [{ role: "user", content: "capital of France?" }],
    })

    expect(chat.seen[0]?.model).toBe("anthropic/claude-sonnet-4.6")
    expect(chat.seen[0]?.messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "capital of France?" },
    ])
    expect(result.text).toBe("Paris.")
    expect(result.toolCalls).toEqual([])
    expect(result.response.messages).toEqual([{ role: "assistant", content: "Paris." }])
    expect(usage).toEqual({ promptTokens: 5, completionTokens: 3, cost: 0 })
  })

  it("maps tool calls (parsing arguments) and reconstructs the assistant message", async () => {
    const chat = stub({
      message: {
        content: null,
        tool_calls: [{ id: "c1", type: "function", function: { name: "send_message", arguments: '{"content":"hi"}' } }],
      },
      model: "stub",
    })
    const usage: UsageAccumulator = { promptTokens: 0, completionTokens: 0, cost: 0 }
    const ai = createEnclaveAI(chat.fn, usage)

    const result = await ai.generateTextWithTools({
      model: MODEL,
      modelString: "m",
      messages: [{ role: "user", content: "say hi" }],
    })

    expect(result.text).toBe("")
    expect(result.toolCalls).toEqual([{ toolCallId: "c1", toolName: "send_message", input: { content: "hi" } }])
    expect(result.response.messages).toEqual([
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "c1", toolName: "send_message", input: { content: "hi" } }],
      },
    ])
  })

  it("accumulates token usage and cost across calls", async () => {
    const chat = stub({
      message: { content: "x" },
      model: "stub",
      usage: { prompt_tokens: 4, completion_tokens: 2, cost: 0.25 },
    })
    const usage: UsageAccumulator = { promptTokens: 0, completionTokens: 0, cost: 0 }
    const ai = createEnclaveAI(chat.fn, usage)
    const opts = { model: MODEL, modelString: "m", messages: [{ role: "user" as const, content: "hi" }] }
    await ai.generateTextWithTools(opts)
    await ai.generateTextWithTools(opts)
    expect(usage).toEqual({ promptTokens: 8, completionTokens: 4, cost: 0.5 })
  })
})
