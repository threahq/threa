import { describe, expect, it, mock } from "bun:test"
import { z } from "zod"
import { AgentToolNames, AgentStepTypes } from "@threa/types"
import type { AgentEvent } from "./agent-events"
import { AgentRuntime } from "./agent-runtime"
import { defineAgentTool } from "./agent-tool"

describe("AgentRuntime message counting", () => {
  it("bridges supersede reruns with a trailing user prompt when history ends with assistant", async () => {
    const generateTextWithTools = mock(async ({ messages }: { messages: Array<{ role: string; content: string }> }) => {
      expect(messages).toHaveLength(3)
      expect(messages.at(-2)).toEqual({
        role: "assistant",
        content: "Hey! :wave: Great to see you. I'm Ariadne, your thinking companion here in Threa.",
      })
      expect(messages.at(-1)?.role).toBe("user")
      expect(messages.at(-1)?.content).toContain("keep_response or send_message")

      return {
        text: "",
        toolCalls: [
          {
            toolCallId: "tool_1",
            toolName: "keep_response",
            input: {
              reason: "The greeting edit does not change what the previous response should say.",
            },
          },
        ],
        response: {
          messages: [{ role: "assistant", content: "No update needed." } as any],
        },
      }
    })

    const runtime = new AgentRuntime({
      ai: { generateTextWithTools } as any,
      model: {} as any,
      systemPrompt: "You are helpful.",
      messages: [
        { role: "user", content: "(14:54) Hi there :wave: My friend!" },
        {
          role: "assistant",
          content: "Hey! :wave: Great to see you. I'm Ariadne, your thinking companion here in Threa.",
        },
      ],
      tools: [],
      allowNoMessageOutput: true,
      sendMessage: async () => ({ messageId: "msg_unused", operation: "created" }),
    })

    const result = await runtime.run()

    expect(generateTextWithTools).toHaveBeenCalledTimes(1)
    expect(result.messagesSent).toBe(0)
    expect(result.noMessageReason).toBe("The greeting edit does not change what the previous response should say.")
  })

  it("counts edited responses as sent output", async () => {
    const events: AgentEvent[] = []

    const runtime = new AgentRuntime({
      ai: {
        generateTextWithTools: async () => ({
          text: "",
          toolCalls: [
            {
              toolCallId: "tool_1",
              toolName: AgentToolNames.SEND_MESSAGE,
              input: { content: "Updated response" },
            },
          ],
          response: {
            messages: [{ role: "assistant", content: "Updating response now." } as any],
          },
        }),
      } as any,
      model: {} as any,
      systemPrompt: "You are helpful.",
      messages: [{ role: "user", content: "Please update your previous answer." }],
      tools: [],
      sendMessage: async () => ({ messageId: "msg_1", operation: "edited" }),
      observers: [
        {
          handle: async (event: AgentEvent) => {
            events.push(event)
          },
        },
      ],
    })

    const result = await runtime.run()

    expect(result.messagesSent).toBe(1)
    expect(result.sentMessageIds).toEqual(["msg_1"])
    expect(events.some((event) => event.type === "message:edited")).toBe(true)
    expect(events.some((event) => event.type === "session:end" && event.messagesSent === 1)).toBe(true)
  })

  it("stops early when rerun drafts repeatedly fail validation", async () => {
    const events: AgentEvent[] = []
    const generateTextWithTools = mock(async () => ({
      text: "I've already sent three replies.",
      toolCalls: [],
      response: {
        messages: [{ role: "assistant", content: "I've already sent three replies." } as any],
      },
    }))

    const runtime = new AgentRuntime({
      ai: { generateTextWithTools } as any,
      model: {} as any,
      systemPrompt: "You are helpful.",
      messages: [{ role: "user", content: "Reply three times with numbers." }],
      tools: [],
      allowNoMessageOutput: true,
      validateFinalResponse: async () => "Send the requested reply content, not an action summary.",
      sendMessage: async () => ({ messageId: "msg_unused", operation: "created" }),
      observers: [
        {
          handle: async (event: AgentEvent) => {
            events.push(event)
          },
        },
      ],
    })

    const result = await runtime.run()

    expect(generateTextWithTools).toHaveBeenCalledTimes(3)
    expect(result.messagesSent).toBe(0)
    expect(result.noMessageReason).toBe(
      "Kept the previous response because revised drafts repeatedly failed validation after context updates."
    )
    expect(events.some((event) => event.type === "response:kept")).toBe(true)
  })

  it("forwards model config and cost context to generateTextWithTools", async () => {
    const captured: Array<{
      modelString?: string
      context?: Record<string, unknown>
      maxTokens?: number
      temperature?: number
    }> = []
    const generateTextWithTools = mock(
      async (opts: {
        modelString?: string
        context?: Record<string, unknown>
        maxTokens?: number
        temperature?: number
      }) => {
        captured.push({
          modelString: opts.modelString,
          context: opts.context,
          maxTokens: opts.maxTokens,
          temperature: opts.temperature,
        })
        return {
          text: "All done.",
          toolCalls: [],
          response: {
            messages: [{ role: "assistant", content: "All done." } as any],
          },
        }
      }
    )

    const runtime = new AgentRuntime({
      ai: { generateTextWithTools } as any,
      model: {} as any,
      modelString: "openrouter:anthropic/claude-haiku-4.5",
      maxTokens: 500,
      temperature: 0.2,
      costContext: {
        workspaceId: "ws_abc",
        userId: "user_xyz",
        sessionId: "session_123",
        origin: "user",
      },
      systemPrompt: "You are helpful.",
      messages: [{ role: "user", content: "Say hi." }],
      tools: [],
      sendMessage: async () => ({ messageId: "msg_1", operation: "created" }),
    })

    const result = await runtime.run()

    expect(result.messagesSent).toBe(1)
    expect(captured).toHaveLength(1)
    expect(captured[0]).toEqual({
      modelString: "openrouter:anthropic/claude-haiku-4.5",
      maxTokens: 500,
      temperature: 0.2,
      context: {
        workspaceId: "ws_abc",
        userId: "user_xyz",
        sessionId: "session_123",
        origin: "user",
      },
    })
  })

  it("commits captured content text when a supersede rerun ends in keep_response", async () => {
    // Reproduces the bug where a scratchpad rerun produces real assistant
    // text alongside a keep_response tool call, then resolves with no message
    // sent. The runtime should fall back to committing the captured text.
    const events: AgentEvent[] = []
    const sendMessage = mock(async (input: { content: string }) => ({
      messageId: "msg_recovered",
      operation: "created" as const,
      content: input.content,
    }))

    const generateTextWithTools = mock(async () => ({
      text: "Found it! You shared this in your Casual Greeting conversation.",
      toolCalls: [
        {
          toolCallId: "tool_keep",
          toolName: "keep_response",
          input: { reason: "Previous response still fits." },
        },
      ],
      response: {
        messages: [
          {
            role: "assistant",
            content: "Found it! You shared this in your Casual Greeting conversation.",
          } as any,
        ],
      },
    }))

    const runtime = new AgentRuntime({
      ai: { generateTextWithTools } as any,
      model: {} as any,
      systemPrompt: "You are helpful.",
      messages: [{ role: "user", content: "I sent a picture of my daughter, can you find it?" }],
      tools: [],
      allowNoMessageOutput: true,
      sendMessage,
      observers: [
        {
          handle: async (event: AgentEvent) => {
            events.push(event)
          },
        },
      ],
    })

    const result = await runtime.run()

    expect(result.messagesSent).toBe(1)
    expect(result.sentMessageIds).toEqual(["msg_recovered"])
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(sendMessage.mock.calls[0]?.[0].content).toBe(
      "Found it! You shared this in your Casual Greeting conversation."
    )
    // We sent a message, so we must NOT also have emitted a misleading
    // "kept previous response" trace step.
    expect(events.some((event) => event.type === "response:kept")).toBe(false)
    expect(events.some((event) => event.type === "message:sent")).toBe(true)
  })

  it("stops early when rerun keeps returning empty final decisions", async () => {
    const generateTextWithTools = mock(async () => ({
      text: " ",
      toolCalls: [],
      response: {
        messages: [{ role: "assistant", content: " " } as any],
      },
    }))

    const runtime = new AgentRuntime({
      ai: { generateTextWithTools } as any,
      model: {} as any,
      systemPrompt: "You are helpful.",
      messages: [{ role: "user", content: "Reply three times with numbers." }],
      tools: [],
      allowNoMessageOutput: true,
      sendMessage: async () => ({ messageId: "msg_unused", operation: "created" }),
    })

    const result = await runtime.run()

    expect(generateTextWithTools).toHaveBeenCalledTimes(3)
    expect(result.messagesSent).toBe(0)
    expect(result.noMessageReason).toBe(
      "Kept the previous response because the rerun produced no actionable output after repeated attempts."
    )
  })
})

describe("AgentRuntime tool progress + signal plumbing", () => {
  it("provides toolSignalProvider's signal to the tool's execute opts", async () => {
    const controller = new AbortController()
    let receivedSignal: AbortSignal | undefined
    const echoTool = defineAgentTool({
      name: "echo_tool",
      description: "test",
      inputSchema: z.object({}),
      execute: async (_input, opts) => {
        receivedSignal = opts.signal
        return { output: "{}" }
      },
      trace: {
        stepType: AgentStepTypes.WORKSPACE_SEARCH,
        formatContent: () => "{}",
      },
    })

    let firstCall = true
    const generateTextWithTools = async () => {
      if (firstCall) {
        firstCall = false
        return {
          text: "",
          toolCalls: [{ toolCallId: "tc_1", toolName: "echo_tool", input: {} }],
          response: { messages: [{ role: "assistant" as const, content: "calling tool" } as any] },
        }
      }
      return {
        text: "Done.",
        toolCalls: [],
        response: { messages: [{ role: "assistant" as const, content: "Done." } as any] },
      }
    }

    const runtime = new AgentRuntime({
      ai: { generateTextWithTools } as any,
      model: {} as any,
      systemPrompt: "You are helpful.",
      messages: [{ role: "user", content: "do it" }],
      tools: [echoTool],
      sendMessage: async () => ({ messageId: "msg_1", operation: "created" }),
      toolSignalProvider: (toolCallId, toolName) => {
        expect(toolCallId).toBe("tc_1")
        expect(toolName).toBe("echo_tool")
        return controller.signal
      },
    })

    await runtime.run()
    expect(receivedSignal).toBe(controller.signal)
  })

  it("emits tool:progress events when the tool calls onProgress", async () => {
    const events: AgentEvent[] = []
    const progressTool = defineAgentTool({
      name: "progress_tool",
      description: "test",
      inputSchema: z.object({}),
      execute: async (_input, { onProgress }) => {
        onProgress?.("Planning queries…")
        onProgress?.("Searching memos and messages…")
        onProgress?.("Evaluating results…")
        return { output: "{}" }
      },
      trace: {
        stepType: AgentStepTypes.WORKSPACE_SEARCH,
        formatContent: () => "{}",
      },
    })

    let firstCall = true
    const generateTextWithTools = async () => {
      if (firstCall) {
        firstCall = false
        return {
          text: "",
          toolCalls: [{ toolCallId: "tc_1", toolName: "progress_tool", input: {} }],
          response: { messages: [{ role: "assistant" as const, content: "calling tool" } as any] },
        }
      }
      return {
        text: "Done.",
        toolCalls: [],
        response: { messages: [{ role: "assistant" as const, content: "Done." } as any] },
      }
    }

    const runtime = new AgentRuntime({
      ai: { generateTextWithTools } as any,
      model: {} as any,
      systemPrompt: "You are helpful.",
      messages: [{ role: "user", content: "do it" }],
      tools: [progressTool],
      sendMessage: async () => ({ messageId: "msg_1", operation: "created" }),
      observers: [
        {
          handle: async (event: AgentEvent) => {
            events.push(event)
          },
        },
      ],
    })

    await runtime.run()

    const progressEvents = events.filter(
      (e): e is Extract<AgentEvent, { type: "tool:progress" }> => e.type === "tool:progress"
    )
    expect(progressEvents).toHaveLength(3)
    expect(progressEvents[0]?.substep).toBe("Planning queries…")
    expect(progressEvents[0]?.toolCallId).toBe("tc_1")
    expect(progressEvents[0]?.stepType).toBe(AgentStepTypes.WORKSPACE_SEARCH)
    expect(progressEvents[1]?.substep).toBe("Searching memos and messages…")
    expect(progressEvents[2]?.substep).toBe("Evaluating results…")
  })

  it("does not provide a signal when toolSignalProvider returns undefined", async () => {
    let receivedSignal: AbortSignal | undefined = new AbortController().signal // sentinel
    const echoTool = defineAgentTool({
      name: "echo_tool",
      description: "test",
      inputSchema: z.object({}),
      execute: async (_input, opts) => {
        receivedSignal = opts.signal
        return { output: "{}" }
      },
      trace: {
        stepType: AgentStepTypes.WORKSPACE_SEARCH,
        formatContent: () => "{}",
      },
    })

    let firstCall = true
    const generateTextWithTools = async () => {
      if (firstCall) {
        firstCall = false
        return {
          text: "",
          toolCalls: [{ toolCallId: "tc_1", toolName: "echo_tool", input: {} }],
          response: { messages: [{ role: "assistant" as const, content: "calling tool" } as any] },
        }
      }
      return {
        text: "Done.",
        toolCalls: [],
        response: { messages: [{ role: "assistant" as const, content: "Done." } as any] },
      }
    }

    const runtime = new AgentRuntime({
      ai: { generateTextWithTools } as any,
      model: {} as any,
      systemPrompt: "You are helpful.",
      messages: [{ role: "user", content: "do it" }],
      tools: [echoTool],
      sendMessage: async () => ({ messageId: "msg_1", operation: "created" }),
      toolSignalProvider: () => undefined,
    })

    await runtime.run()
    expect(receivedSignal).toBeUndefined()
  })
})
