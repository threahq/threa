import { describe, expect, it } from "vitest"
import { z } from "zod"
import type { ModelMessage } from "ai"
import { buildAssistantMessage, toOpenAiMessages, toOpenAiTools } from "./openai-format"

describe("toOpenAiMessages", () => {
  it("maps system + plain user/assistant turns", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ]
    expect(toOpenAiMessages("be nice", messages)).toEqual([
      { role: "system", content: "be nice" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ])
  })

  it("emits tool_calls for an assistant message carrying tool-call parts", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "let me check" },
          { type: "tool-call", toolCallId: "c1", toolName: "send_message", input: { content: "ok" } },
        ],
      } as unknown as ModelMessage,
    ]
    expect(toOpenAiMessages(undefined, messages)).toEqual([
      {
        role: "assistant",
        content: "let me check",
        tool_calls: [{ id: "c1", type: "function", function: { name: "send_message", arguments: '{"content":"ok"}' } }],
      },
    ])
  })

  it("fans a tool-role message out to one OpenAI tool message per result, keyed by call id", () => {
    const messages: ModelMessage[] = [
      {
        role: "tool",
        content: [
          { type: "tool-result", toolCallId: "c1", toolName: "search", output: { type: "text", value: "result A" } },
          { type: "tool-result", toolCallId: "c2", toolName: "search", output: { type: "text", value: "result B" } },
        ],
      } as unknown as ModelMessage,
    ]
    expect(toOpenAiMessages(undefined, messages)).toEqual([
      { role: "tool", tool_call_id: "c1", content: "result A" },
      { role: "tool", tool_call_id: "c2", content: "result B" },
    ])
  })
})

describe("toOpenAiTools", () => {
  it("converts a zod input schema into an OpenAI function tool", () => {
    const tools = {
      greet: { description: "Greet someone", inputSchema: z.object({ name: z.string() }) },
    } as unknown as Record<string, never>

    const out = toOpenAiTools(tools)
    expect(out).toHaveLength(1)
    expect(out![0]!.type).toBe("function")
    expect(out![0]!.function.name).toBe("greet")
    expect(out![0]!.function.description).toBe("Greet someone")
    // zod → JSON Schema: an object schema with a required string `name`.
    const params = out![0]!.function.parameters as { type?: string; properties?: Record<string, unknown> }
    expect(params.type).toBe("object")
    expect(params.properties).toHaveProperty("name")
  })

  it("returns undefined when there are no tools", () => {
    expect(toOpenAiTools(undefined)).toBeUndefined()
    expect(toOpenAiTools({})).toBeUndefined()
  })
})

describe("buildAssistantMessage", () => {
  it("keeps text-only replies as a string", () => {
    expect(buildAssistantMessage("just text", [])).toEqual({ role: "assistant", content: "just text" })
  })

  it("rebuilds tool-call parts so the conversation round-trips", () => {
    const msg = buildAssistantMessage("thinking", [
      { toolCallId: "c1", toolName: "send_message", input: { content: "x" } },
    ])
    expect(msg).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "thinking" },
        { type: "tool-call", toolCallId: "c1", toolName: "send_message", input: { content: "x" } },
      ],
    })
  })
})
