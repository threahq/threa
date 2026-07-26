import { describe, expect, test } from "bun:test"
import type { ModelMessage } from "ai"
import { sanitizeAssistantReplay } from "./reasoning-replay"

const detail = {
  type: "reasoning.text",
  text: "Let me think about the user's request carefully.",
  index: 0,
  signature: "ErkJCok",
  format: "anthropic-claude-v1",
}

describe("sanitizeAssistantReplay", () => {
  test("keeps only the reasoning part's copy when a tool call duplicates it", () => {
    const message = {
      role: "assistant",
      content: [
        { type: "reasoning", text: "thinking", providerOptions: { openrouter: { reasoning_details: [detail] } } },
        {
          type: "tool-call",
          toolCallId: "tc_1",
          toolName: "search",
          input: {},
          providerOptions: { openrouter: { reasoning_details: [detail] } },
        },
      ],
    } as unknown as ModelMessage

    expect(sanitizeAssistantReplay(message)).toEqual({
      role: "assistant",
      content: [
        { type: "reasoning", text: "thinking", providerOptions: { openrouter: { reasoning_details: [detail] } } },
        {
          type: "tool-call",
          toolCallId: "tc_1",
          toolName: "search",
          input: {},
          providerOptions: { openrouter: {} },
        },
      ],
    } as unknown as ModelMessage)
  })

  test("strips the copy from every tool call", () => {
    const message = {
      role: "assistant",
      content: [
        { type: "reasoning", text: "thinking", providerOptions: { openrouter: { reasoning_details: [detail] } } },
        {
          type: "tool-call",
          toolCallId: "tc_1",
          toolName: "search",
          input: {},
          providerOptions: { openrouter: { reasoning_details: [detail] } },
        },
        {
          type: "tool-call",
          toolCallId: "tc_2",
          toolName: "fetch",
          input: {},
          providerOptions: { openrouter: { reasoning_details: [detail] } },
        },
      ],
    } as unknown as ModelMessage

    expect(sanitizeAssistantReplay(message)).toEqual({
      role: "assistant",
      content: [
        { type: "reasoning", text: "thinking", providerOptions: { openrouter: { reasoning_details: [detail] } } },
        { type: "tool-call", toolCallId: "tc_1", toolName: "search", input: {}, providerOptions: { openrouter: {} } },
        { type: "tool-call", toolCallId: "tc_2", toolName: "fetch", input: {}, providerOptions: { openrouter: {} } },
      ],
    } as unknown as ModelMessage)
  })

  test("returns unchanged when only the tool call carries details", () => {
    const message = {
      role: "assistant",
      content: [
        { type: "reasoning", text: "thinking" },
        {
          type: "tool-call",
          toolCallId: "tc_1",
          toolName: "search",
          input: {},
          providerOptions: { openrouter: { reasoning_details: [detail] } },
        },
      ],
    } as unknown as ModelMessage

    expect(sanitizeAssistantReplay(message)).toBe(message)
  })

  test("returns a message with no openrouter options deep-equal to input", () => {
    const message = {
      role: "assistant",
      content: [
        { type: "text", text: "hello" },
        { type: "tool-call", toolCallId: "tc_1", toolName: "search", input: {} },
      ],
    } as unknown as ModelMessage

    expect(sanitizeAssistantReplay(message)).toEqual(message)
  })

  test("preserves other openrouter keys and other provider namespaces", () => {
    const message = {
      role: "assistant",
      content: [
        { type: "reasoning", text: "thinking", providerOptions: { openrouter: { reasoning_details: [detail] } } },
        {
          type: "tool-call",
          toolCallId: "tc_1",
          toolName: "search",
          input: {},
          providerOptions: {
            openrouter: { reasoning_details: [detail], annotations: [{ type: "url_citation" }] },
            anthropic: { cacheControl: { type: "ephemeral" } },
          },
        },
      ],
    } as unknown as ModelMessage

    expect(sanitizeAssistantReplay(message)).toEqual({
      role: "assistant",
      content: [
        { type: "reasoning", text: "thinking", providerOptions: { openrouter: { reasoning_details: [detail] } } },
        {
          type: "tool-call",
          toolCallId: "tc_1",
          toolName: "search",
          input: {},
          providerOptions: {
            openrouter: { annotations: [{ type: "url_citation" }] },
            anthropic: { cacheControl: { type: "ephemeral" } },
          },
        },
      ],
    } as unknown as ModelMessage)
  })

  test("returns non-assistant and string-content messages as-is", () => {
    const userMessage = { role: "user", content: "hi" } as ModelMessage
    const stringAssistant = { role: "assistant", content: "hello" } as ModelMessage

    expect([sanitizeAssistantReplay(userMessage), sanitizeAssistantReplay(stringAssistant)]).toEqual([
      userMessage,
      stringAssistant,
    ])
  })

  test("does not mutate the input", () => {
    const message = {
      role: "assistant",
      content: [
        { type: "reasoning", text: "thinking", providerOptions: { openrouter: { reasoning_details: [detail] } } },
        {
          type: "tool-call",
          toolCallId: "tc_1",
          toolName: "search",
          input: {},
          providerOptions: { openrouter: { reasoning_details: [detail] } },
        },
      ],
    } as unknown as ModelMessage
    const before = structuredClone(message)

    sanitizeAssistantReplay(message)

    expect(message).toEqual(before)
  })
})
