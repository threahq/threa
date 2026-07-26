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
    // The stable system message now rides a content part so it can carry the
    // cache breakpoint; anthropic/* is in the set that needs an explicit one.
    expect(chat.seen[0]?.messages).toEqual([
      { role: "system", content: [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }] },
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

  it("forwards the abort signal so a Stop can cancel the in-flight call", async () => {
    const chat = stub({ message: { content: "x" }, model: "stub" })
    const usage: UsageAccumulator = { promptTokens: 0, completionTokens: 0, cost: 0 }
    const ai = createEnclaveAI(chat.fn, usage)
    const controller = new AbortController()

    await ai.generateTextWithTools({
      model: MODEL,
      modelString: "m",
      messages: [{ role: "user", content: "hi" }],
      abortSignal: controller.signal,
    })

    expect(chat.seen[0]?.signal).toBe(controller.signal)
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

describe("createEnclaveAI cache breakpoints", () => {
  const reply = { message: { content: "ok" }, model: "stub", usage: { prompt_tokens: 1, completion_tokens: 1 } }

  it("emits the volatile half as an unmarked system message after the breakpoint", async () => {
    const chat = stub(reply)
    const ai = createEnclaveAI(chat.fn, { promptTokens: 0, completionTokens: 0, cost: 0 })

    await ai.generateTextWithTools({
      model: MODEL,
      modelString: "anthropic/claude-sonnet-4.6",
      system: "stable",
      volatileSystem: "## Current Time\n\n10:00",
      messages: [{ role: "user", content: "hi" }],
    })

    expect(chat.seen[0]?.messages).toEqual([
      { role: "system", content: [{ type: "text", text: "stable", cache_control: { type: "ephemeral" } }] },
      { role: "system", content: "## Current Time\n\n10:00" },
      { role: "user", content: "hi" },
    ])
  })

  // OpenAI caches automatically, so marking it would be noise. The provider set
  // lives in agent-runtime so host and enclave cannot drift to different lists.
  it("omits the breakpoint for a provider that needs no explicit marker", async () => {
    const chat = stub(reply)
    const ai = createEnclaveAI(chat.fn, { promptTokens: 0, completionTokens: 0, cost: 0 })

    await ai.generateTextWithTools({
      model: MODEL,
      modelString: "openai/gpt-5-mini",
      system: "stable",
      messages: [{ role: "user", content: "hi" }],
    })

    expect(chat.seen[0]?.messages[0]).toEqual({ role: "system", content: "stable" })
  })
})
