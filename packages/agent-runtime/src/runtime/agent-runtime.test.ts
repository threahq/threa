import { describe, expect, it, mock } from "bun:test"
import { z } from "zod"
import { AgentToolNames, AgentStepTypes, type SourceItem } from "@threa/types"
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
    // A deliberate keep_response is not a validation failure — it must not
    // trigger model escalation on the next rerun (roadmap 2.3).
    expect(result.responseValidationFailed).toBe(false)
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
    // The structured signal dispatch persists so the NEXT rerun of this work
    // escalates to the persona's escalationModel (roadmap 2.3).
    expect(result.responseValidationFailed).toBe(true)
  })

  it("stops early when send_message drafts repeatedly fail validation (tool-call finalization path)", async () => {
    // The supersede-rerun prompt mandates finalizing via send_message /
    // keep_response tool calls, so the invalid-draft terminal must trip on the
    // pendingMessages path too — not only on plain assistant text.
    const generateTextWithTools = mock(async () => ({
      text: "",
      toolCalls: [
        {
          toolCallId: "tool_1",
          toolName: AgentToolNames.SEND_MESSAGE,
          input: { content: "I've already sent three replies." },
        },
      ],
      response: {
        messages: [{ role: "assistant", content: "" } as any],
      },
    }))
    const sendMessage = mock(async () => ({ messageId: "msg_unused", operation: "created" as const }))

    const runtime = new AgentRuntime({
      ai: { generateTextWithTools } as any,
      model: {} as any,
      systemPrompt: "You are helpful.",
      messages: [{ role: "user", content: "Reply three times with numbers." }],
      tools: [],
      allowNoMessageOutput: true,
      validateFinalResponse: async () => "Send the requested reply content, not an action summary.",
      sendMessage,
    })

    const result = await runtime.run()

    expect(generateTextWithTools).toHaveBeenCalledTimes(3)
    expect(sendMessage).not.toHaveBeenCalled()
    expect(result.messagesSent).toBe(0)
    expect(result.noMessageReason).toBe(
      "Kept the previous response because revised drafts repeatedly failed validation after context updates."
    )
    expect(result.responseValidationFailed).toBe(true)
  })

  it("keeps revising past the ordinary cap when a rerun's rejected drafts differ", async () => {
    // Supersede reruns get the full iteration budget: an LLM judge's reason
    // text varies, so drafts are never byte-identical and the ordinary
    // 3-rejection cap would kill a turn that is still converging.
    let calls = 0
    const generateTextWithTools = mock(async () => {
      calls++
      return {
        text: "",
        toolCalls: [
          {
            toolCallId: `tool_${calls}`,
            toolName: AgentToolNames.SEND_MESSAGE,
            input: { content: `Draft ${calls}` },
          },
        ],
        response: { messages: [{ role: "assistant", content: "" } as any] },
      }
    })
    const sendMessage = mock(async () => ({ messageId: "msg_final", operation: "created" as const }))

    const runtime = new AgentRuntime({
      ai: { generateTextWithTools } as any,
      model: {} as any,
      systemPrompt: "You are helpful.",
      messages: [{ role: "user", content: "Reply three times with numbers." }],
      tools: [],
      allowNoMessageOutput: true,
      validateFinalResponse: async (content: string) =>
        content === "Draft 4" ? null : `Rejected ${content}: needs the actual answer.`,
      sendMessage,
    })

    const result = await runtime.run()

    expect(generateTextWithTools).toHaveBeenCalledTimes(4)
    expect(result.messagesSent).toBe(1)
    expect(result.sentMessageIds).toEqual(["msg_final"])
    expect(result.responseValidationFailed).toBeFalsy()
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

describe("AgentRuntime initial context", () => {
  const replyOnce = () => ({
    text: "",
    toolCalls: [{ toolCallId: "tool_1", toolName: AgentToolNames.SEND_MESSAGE, input: { content: "Hi." } }],
    response: { messages: [{ role: "assistant", content: "Replying." } as any] },
  })

  it("emits context:received with the configured messages and extras right after session:start", async () => {
    const events: AgentEvent[] = []
    const initialContext = {
      messages: [
        {
          messageId: "msg_trigger",
          authorName: "Kris",
          authorType: "user" as const,
          createdAt: "2026-06-11T09:00:00.000Z",
          content: "Hi 👋",
          isTrigger: true,
        },
      ],
      extras: { synthesized: true },
    }

    const runtime = new AgentRuntime({
      ai: { generateTextWithTools: async () => replyOnce() } as any,
      model: {} as any,
      systemPrompt: "You are helpful.",
      messages: [{ role: "user", content: "Hi 👋" }],
      tools: [],
      initialContext,
      sendMessage: async () => ({ messageId: "msg_1", operation: "created" }),
      observers: [{ handle: async (event: AgentEvent) => void events.push(event) }],
    })

    await runtime.run()

    expect(events[0]!.type).toBe("session:start")
    expect(events[1]).toEqual({ type: "context:received", ...initialContext })
  })

  it("emits no context:received when initialContext is omitted", async () => {
    const events: AgentEvent[] = []

    const runtime = new AgentRuntime({
      ai: { generateTextWithTools: async () => replyOnce() } as any,
      model: {} as any,
      systemPrompt: "You are helpful.",
      messages: [{ role: "user", content: "Hi 👋" }],
      tools: [],
      sendMessage: async () => ({ messageId: "msg_1", operation: "created" }),
      observers: [{ handle: async (event: AgentEvent) => void events.push(event) }],
    })

    await runtime.run()

    expect(events.some((event) => event.type === "context:received")).toBe(false)
  })
})

describe("AgentRuntime source commitment", () => {
  // §2.8 q4 spike: the required-sources commit payload must not be quietly
  // defeated — a turn whose tool results carried sources commits them non-empty.
  it("commits non-empty sources when a tool result carried sources", async () => {
    const committed: Array<{ content: string; sources: SourceItem[] }> = []
    const citingTool = defineAgentTool({
      name: "citing_tool",
      description: "test",
      categories: [],
      inputSchema: z.object({}),
      execute: async () => ({
        output: JSON.stringify({ summary: "found it" }),
        sources: [{ type: "web" as const, title: "Example Page", url: "https://example.com/page" }],
      }),
      trace: {
        stepType: AgentStepTypes.VISIT_PAGE,
        formatContent: () => "{}",
      },
    })

    let firstCall = true
    const generateTextWithTools = async () => {
      if (firstCall) {
        firstCall = false
        return {
          text: "",
          toolCalls: [{ toolCallId: "tc_1", toolName: "citing_tool", input: {} }],
          response: { messages: [{ role: "assistant" as const, content: "researching" } as any] },
        }
      }
      return {
        text: "Here is what I found.",
        toolCalls: [],
        response: { messages: [{ role: "assistant" as const, content: "Here is what I found." } as any] },
      }
    }

    const runtime = new AgentRuntime({
      ai: { generateTextWithTools } as any,
      model: {} as any,
      systemPrompt: "You are helpful.",
      messages: [{ role: "user", content: "research this" }],
      tools: [citingTool],
      sendMessage: async ({ content, sources }) => {
        committed.push({ content, sources })
        return { messageId: "msg_1", operation: "created" }
      },
    })

    const result = await runtime.run()

    expect(committed).toHaveLength(1)
    expect(committed[0]?.sources).toEqual([{ type: "web", title: "Example Page", url: "https://example.com/page" }])
    expect(result.sources).toEqual([{ type: "web", title: "Example Page", url: "https://example.com/page" }])
  })

  it("commits an empty sources array (not undefined) for a sourceless turn", async () => {
    const committed: Array<{ sources: unknown }> = []
    const runtime = new AgentRuntime({
      ai: {
        generateTextWithTools: async () => ({
          text: "Hi.",
          toolCalls: [],
          response: { messages: [{ role: "assistant", content: "Hi." } as any] },
        }),
      } as any,
      model: {} as any,
      systemPrompt: "You are helpful.",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
      sendMessage: async ({ sources }) => {
        committed.push({ sources })
        return { messageId: "msg_1", operation: "created" }
      },
    })

    await runtime.run()

    expect(committed).toEqual([{ sources: [] }])
  })
})

describe("AgentRuntime reasoning replay", () => {
  it("replays the assistant turn with a single copy of reasoning_details", async () => {
    const detail = {
      type: "reasoning.text",
      text: "Thinking about the request.",
      index: 0,
      signature: "ErkJCok",
      format: "anthropic-claude-v1",
    }
    const echoTool = defineAgentTool({
      name: "echo_tool",
      description: "test",
      categories: [],
      inputSchema: z.object({}),
      execute: async () => ({ output: "ok" }),
      trace: { stepType: AgentStepTypes.VISIT_PAGE, formatContent: () => "{}" },
    })

    const calls: Array<Array<{ role: string; content: unknown }>> = []
    let firstCall = true
    const generateTextWithTools = async ({ messages }: { messages: Array<{ role: string; content: unknown }> }) => {
      calls.push(messages)
      if (firstCall) {
        firstCall = false
        return {
          text: "",
          toolCalls: [{ toolCallId: "tc_1", toolName: "echo_tool", input: {} }],
          response: {
            messages: [
              {
                role: "assistant" as const,
                content: [
                  {
                    type: "reasoning",
                    text: "thinking",
                    providerOptions: { openrouter: { reasoning_details: [detail] } },
                  },
                  {
                    type: "tool-call",
                    toolCallId: "tc_1",
                    toolName: "echo_tool",
                    input: {},
                    providerOptions: { openrouter: { reasoning_details: [detail] } },
                  },
                ],
              } as any,
            ],
          },
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
    })

    await runtime.run()

    const replayed = calls[1]?.find((m) => m.role === "assistant")
    expect(replayed).toEqual({
      role: "assistant",
      content: [
        { type: "reasoning", text: "thinking", providerOptions: { openrouter: { reasoning_details: [detail] } } },
        {
          type: "tool-call",
          toolCallId: "tc_1",
          toolName: "echo_tool",
          input: {},
          providerOptions: { openrouter: {} },
        },
      ],
    })
  })
})

describe("AgentRuntime tool progress + signal plumbing", () => {
  it("provides toolSignalProvider's signal to the tool's execute opts", async () => {
    const controller = new AbortController()
    let receivedSignal: AbortSignal | undefined
    const echoTool = defineAgentTool({
      name: "echo_tool",
      description: "test",
      categories: [],
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
      categories: [],
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
      categories: [],
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

describe("AgentRuntime runAbortSignal (graceful session Stop)", () => {
  const emptyReply = () => ({
    text: "reply",
    toolCalls: [],
    response: { messages: [{ role: "assistant" as const, content: "reply" } as any] },
  })

  it("halts before the LLM call when the signal is already aborted, without committing", async () => {
    const controller = new AbortController()
    controller.abort("user_abort")
    const generateTextWithTools = mock(async () => emptyReply())
    const sendMessage = mock(async () => ({ messageId: "msg_1", operation: "created" as const }))

    const runtime = new AgentRuntime({
      ai: { generateTextWithTools } as any,
      model: {} as any,
      systemPrompt: "You are helpful.",
      messages: [{ role: "user", content: "do it" }],
      tools: [],
      sendMessage,
      runAbortSignal: controller.signal,
    })

    const result = await runtime.run()

    expect(generateTextWithTools).not.toHaveBeenCalled()
    expect(sendMessage).not.toHaveBeenCalled()
    expect(result.messagesSent).toBe(0)
    expect(result.noMessageReason).toContain("Stopped by the user")
  })

  it("cancels a pending LLM iteration when the signal aborts mid-call, returning gracefully", async () => {
    const controller = new AbortController()
    // A user Stop lands while the LLM request is in flight: the call sees the
    // aborted signal and rejects, exactly as the AI SDK does on abort.
    const generateTextWithTools = mock(async ({ abortSignal }: { abortSignal?: AbortSignal }) => {
      controller.abort("user_abort")
      if (abortSignal?.aborted) {
        const err = new Error("Aborted")
        err.name = "AbortError"
        throw err
      }
      return emptyReply()
    })
    const sendMessage = mock(async () => ({ messageId: "msg_1", operation: "created" as const }))

    const runtime = new AgentRuntime({
      ai: { generateTextWithTools } as any,
      model: {} as any,
      systemPrompt: "You are helpful.",
      messages: [{ role: "user", content: "do it" }],
      tools: [],
      sendMessage,
      runAbortSignal: controller.signal,
    })

    const result = await runtime.run()

    expect(generateTextWithTools).toHaveBeenCalledTimes(1)
    expect(sendMessage).not.toHaveBeenCalled()
    expect(result.messagesSent).toBe(0)
    expect(result.noMessageReason).toContain("Stopped by the user")
  })

  it("rethrows a non-abort error from the LLM call (not swallowed as a Stop)", async () => {
    const controller = new AbortController()
    const generateTextWithTools = mock(async () => {
      throw new Error("upstream 500")
    })

    const runtime = new AgentRuntime({
      ai: { generateTextWithTools } as any,
      model: {} as any,
      systemPrompt: "You are helpful.",
      messages: [{ role: "user", content: "do it" }],
      tools: [],
      sendMessage: async () => ({ messageId: "msg_1", operation: "created" as const }),
      runAbortSignal: controller.signal,
    })

    await expect(runtime.run()).rejects.toThrow("upstream 500")
  })
})

describe("AgentRuntime mid-turn reconsideration", () => {
  // Regression for the Ariadne/Pierre production failure: a mention question was
  // drafted correctly, an unrelated interjection landed mid-turn, and the model —
  // believing its draft had already been sent — replied only to the interjection.
  const interjection = {
    sequence: BigInt(4265),
    messageId: "msg_banter",
    changeType: "message_created" as const,
    content: "Now you know how to fix sessions ;)",
    authorId: "usr_pierre",
    authorName: "Pierre Boberg",
    authorType: "user" as const,
    createdAt: "2026-07-09T19:34:29.123Z",
  }

  function newMessagesOnce(): { nm: any; updateSequence: ReturnType<typeof mock> } {
    let delivered = false
    const updateSequence = mock(async () => {})
    const nm = {
      check: async () => {
        if (delivered) return []
        delivered = true
        return [interjection]
      },
      updateSequence,
      awaitAttachments: async () => {},
      streamId: "stream_1",
      sessionId: "session_1",
      personaId: "persona_1",
      lastProcessedSequence: BigInt(4263),
    }
    return { nm, updateSequence }
  }

  it("tells the model its text draft was not sent and re-anchors the original request", async () => {
    const { nm, updateSequence } = newMessagesOnce()
    const prompts: Array<Array<{ role: string; content: unknown }>> = []
    let call = 0
    const generateTextWithTools = mock(
      async ({ messages }: { messages: Array<{ role: string; content: unknown }> }) => {
        prompts.push(messages)
        call += 1
        const text =
          call === 1
            ? "Check digits reduce the OTP search space — bad idea."
            : "Final: check digits reduce the OTP search space — bad idea."
        return {
          text,
          toolCalls: [],
          response: { messages: [{ role: "assistant", content: text } as any] },
        }
      }
    )
    const sendMessage = mock(async () => ({ messageId: "msg_reply", operation: "created" as const }))

    const runtime = new AgentRuntime({
      ai: { generateTextWithTools } as any,
      model: {} as any,
      systemPrompt: "You are helpful.",
      messages: [
        {
          role: "user",
          content: "[msg:msg_q author:usr_pierre] [@Pierre Boberg] What about a 5-digit OTP plus a check digit?",
        },
      ],
      tools: [],
      newMessages: nm,
      sendMessage,
    })

    const result = await runtime.run()

    expect(generateTextWithTools).toHaveBeenCalledTimes(2)
    // Injected interjection carries the same author surface as turn-start history.
    const secondCall = prompts[1]!
    const injected = secondCall.find((m) => typeof m.content === "string" && m.content.includes("msg_banter"))
    expect(injected).toMatchObject({
      role: "user",
      content: `[msg:msg_banter author:usr_pierre] [@Pierre Boberg] Now you know how to fix sessions ;)`,
    })
    // The reconsideration prompt must not imply the draft was delivered, and must
    // keep the original request as the thing to answer.
    const runtimePrompt = secondCall.at(-1)!
    expect(runtimePrompt.role).toBe("user")
    expect(runtimePrompt.content).toContain("NOT sent")
    expect(runtimePrompt.content).toContain("Check digits reduce the OTP search space")
    expect(runtimePrompt.content).toContain("answer the original request")
    expect(runtimePrompt.content).toContain("talking to each other")

    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(result.sentContents).toEqual(["Final: check digits reduce the OTP search space — bad idea."])
    expect(updateSequence).toHaveBeenCalledWith("session_1", BigInt(4265))
    expect(result.lastProcessedSequence).toBe(BigInt(4265))
  })

  it("tells the model a pending send_message draft was not committed and re-anchors the original request", async () => {
    const { nm } = newMessagesOnce()
    const prompts: Array<Array<{ role: string; content: unknown }>> = []
    let call = 0
    const generateTextWithTools = mock(
      async ({ messages }: { messages: Array<{ role: string; content: unknown }> }) => {
        prompts.push(messages)
        call += 1
        const content = call === 1 ? "Draft answer to the OTP question." : "Final answer to the OTP question."
        return {
          text: "",
          toolCalls: [{ toolCallId: `tool_${call}`, toolName: AgentToolNames.SEND_MESSAGE, input: { content } }],
          response: { messages: [{ role: "assistant", content: "" } as any] },
        }
      }
    )
    const sendMessage = mock(async () => ({ messageId: "msg_reply", operation: "created" as const }))

    const runtime = new AgentRuntime({
      ai: { generateTextWithTools } as any,
      model: {} as any,
      systemPrompt: "You are helpful.",
      messages: [{ role: "user", content: "What about a 5-digit OTP plus a check digit?" }],
      tools: [],
      newMessages: nm,
      sendMessage,
    })

    const result = await runtime.run()

    expect(generateTextWithTools).toHaveBeenCalledTimes(2)
    const runtimePrompt = prompts[1]!.at(-1)!
    expect(runtimePrompt.role).toBe("user")
    expect(runtimePrompt.content).toContain("NOT sent")
    expect(runtimePrompt.content).toContain("Draft answer to the OTP question.")
    expect(runtimePrompt.content).toContain("answer the original request")

    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(result.sentContents).toEqual(["Final answer to the OTP question."])
  })

  it("re-anchors a keep_response decision when messages arrive after it", async () => {
    const { nm } = newMessagesOnce()
    const prompts: Array<Array<{ role: string; content: unknown }>> = []
    let call = 0
    const generateTextWithTools = mock(
      async ({ messages }: { messages: Array<{ role: string; content: unknown }> }) => {
        prompts.push(messages)
        call += 1
        const reason =
          call === 1
            ? "Prior response still covers the request."
            : "Interjection is a side conversation; prior response stands."
        return {
          text: "",
          toolCalls: [{ toolCallId: `tool_${call}`, toolName: "keep_response", input: { reason } }],
          response: { messages: [{ role: "assistant", content: "" } as any] },
        }
      }
    )
    const sendMessage = mock(async () => ({ messageId: "msg_unused", operation: "created" as const }))

    const runtime = new AgentRuntime({
      ai: { generateTextWithTools } as any,
      model: {} as any,
      systemPrompt: "You are helpful.",
      messages: [
        { role: "user", content: "What about a 5-digit OTP plus a check digit?" },
        { role: "assistant", content: "Check digits shrink the search space - bad idea." },
      ],
      tools: [],
      allowNoMessageOutput: true,
      newMessages: nm,
      sendMessage,
    })

    const result = await runtime.run()

    expect(generateTextWithTools).toHaveBeenCalledTimes(2)
    const runtimePrompt = prompts[1]!.at(-1)!
    expect(runtimePrompt.role).toBe("user")
    // No unsent-draft framing here - the kept response was already delivered.
    // The prompt must carry the shared side-conversation guidance and the
    // keep_response/send_message choice instead of implying completion.
    expect(runtimePrompt.content).toContain("Prior response still covers the request.")
    expect(runtimePrompt.content).toContain("talking to each other")
    expect(runtimePrompt.content).toContain("call keep_response again")

    expect(sendMessage).not.toHaveBeenCalled()
    expect(result.messagesSent).toBe(0)
    expect(result.noMessageReason).toBe("Interjection is a side conversation; prior response stands.")
  })
})

describe("AgentRuntime prompt-cache wiring", () => {
  // The `applyCacheBreakpoints` unit tests would all still pass if the runtime
  // stopped forwarding the halves, so assert the seam this file owns: what the
  // loop actually hands the AI wrapper.
  it("forwards both prompt halves and opts into cache breakpoints", async () => {
    const calls: Array<{ system?: string; volatileSystem?: string; cachePrefix?: boolean }> = []
    const generateTextWithTools = mock(async (opts: any) => {
      calls.push({ system: opts.system, volatileSystem: opts.volatileSystem, cachePrefix: opts.cachePrefix })
      return {
        text: "",
        toolCalls: [{ toolCallId: "t1", toolName: "send_message", input: { content: "hi" } }],
        response: { messages: [] },
      }
    })

    const runtime = new AgentRuntime({
      ai: { generateTextWithTools } as any,
      model: {} as any,
      modelString: "openrouter:anthropic/claude-sonnet-5",
      systemPrompt: "STABLE HALF",
      volatileSystemPrompt: "VOLATILE HALF",
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      sendMessage: async () => ({ messageId: "msg_1" }),
    })

    await runtime.run()

    expect(calls[0]).toEqual({
      system: "STABLE HALF",
      volatileSystem: "VOLATILE HALF",
      cachePrefix: true,
    })
  })

  it("omits the volatile half rather than sending an empty string", async () => {
    const calls: Array<{ volatileSystem?: string }> = []
    const generateTextWithTools = mock(async (opts: any) => {
      calls.push({ volatileSystem: opts.volatileSystem })
      return {
        text: "",
        toolCalls: [{ toolCallId: "t1", toolName: "send_message", input: { content: "hi" } }],
        response: { messages: [] },
      }
    })

    const runtime = new AgentRuntime({
      ai: { generateTextWithTools } as any,
      model: {} as any,
      systemPrompt: "STABLE HALF",
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      sendMessage: async () => ({ messageId: "msg_1" }),
    })

    await runtime.run()

    expect(calls[0]?.volatileSystem).toBeUndefined()
  })
})
