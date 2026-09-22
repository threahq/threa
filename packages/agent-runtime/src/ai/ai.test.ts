import { describe, it, expect, mock, spyOn } from "bun:test"
import { z } from "zod"
import { tool } from "ai"
import {
  parseModelId,
  createAI,
  AISpendDeniedError,
  applyCacheBreakpoints,
  extractUsageWithCost,
  type SpendAdmissionRequest,
} from "./ai"

// Import fixture data captured from real OpenRouter API calls (2026-01-06)
import fixtures from "./fixtures/openrouter-responses.json"

describe("parseModelId", () => {
  it("should parse openrouter model with nested path", () => {
    const result = parseModelId("openrouter:anthropic/claude-haiku-4.5")

    expect(result).toEqual({
      provider: "openrouter",
      modelId: "anthropic/claude-haiku-4.5",
      modelProvider: "anthropic",
      modelName: "claude-haiku-4.5",
    })
  })

  it("should parse openrouter model with openai path", () => {
    const result = parseModelId("openrouter:openai/gpt-5-mini")

    expect(result).toEqual({
      provider: "openrouter",
      modelId: "openai/gpt-5-mini",
      modelProvider: "openai",
      modelName: "gpt-5-mini",
    })
  })

  it("should parse direct anthropic model (no nested path)", () => {
    const result = parseModelId("anthropic:claude-sonnet-4-20250514")

    expect(result).toEqual({
      provider: "anthropic",
      modelId: "claude-sonnet-4-20250514",
      modelProvider: "anthropic",
      modelName: "claude-sonnet-4-20250514",
    })
  })

  it("should parse model with version tag containing colons", () => {
    const result = parseModelId("provider:model:v1:latest")

    expect(result).toEqual({
      provider: "provider",
      modelId: "model:v1:latest",
      modelProvider: "provider",
      modelName: "model:v1:latest",
    })
  })

  it("should throw for missing colon separator", () => {
    expect(() => parseModelId("anthropic-claude-sonnet")).toThrow(
      'Invalid provider:model format: "anthropic-claude-sonnet"'
    )
  })

  it("should throw for empty provider", () => {
    expect(() => parseModelId(":claude-sonnet")).toThrow('Invalid provider:model format: ":claude-sonnet"')
  })

  it("should throw for empty model ID", () => {
    expect(() => parseModelId("anthropic:")).toThrow('Invalid provider:model format: "anthropic:"')
  })
})

describe("createAI", () => {
  describe("configuration", () => {
    it("should throw when provider not configured", () => {
      const ai = createAI({})

      expect(() => ai.getLanguageModel("openrouter:anthropic/claude-haiku-4.5")).toThrow("OpenRouter not configured")
    })

    it("should throw for unsupported provider", () => {
      const ai = createAI({ openrouter: { apiKey: "test-key" } })

      expect(() => ai.getLanguageModel("unknown:some-model")).toThrow('Unsupported provider: "unknown"')
    })
  })

  describe("parseModel", () => {
    it("should expose parseModel function", () => {
      const ai = createAI({})
      const result = ai.parseModel("openrouter:anthropic/claude-haiku-4.5")

      expect(result.modelProvider).toBe("anthropic")
    })
  })
})

describe("API behavior", () => {
  it("should expose telemetry option for embed operations", () => {
    const ai = createAI({ openrouter: { apiKey: "test-key" } })

    // Verify the interface accepts telemetry - actual call would need mocking
    const embedOptions = {
      model: "openrouter:openai/text-embedding-3-small",
      value: "test text",
      telemetry: { functionId: "test-embed" },
    }
    const embedManyOptions = {
      model: "openrouter:openai/text-embedding-3-small",
      values: ["test1", "test2"],
      telemetry: { functionId: "test-embed-many", metadata: { count: 2 } },
    }

    // Type check passes if these compile
    expect(embedOptions.telemetry.functionId).toBe("test-embed")
    expect(embedManyOptions.telemetry.functionId).toBe("test-embed-many")
  })

  it("should have consistent error messages mentioning env var and config", () => {
    const ai = createAI({})

    expect(() => ai.getLanguageModel("openrouter:test")).toThrow(/OPENROUTER_API_KEY.*openrouter\.apiKey/)
    expect(() => ai.getEmbeddingModel("openrouter:test")).toThrow(/OPENROUTER_API_KEY.*openrouter\.apiKey/)
  })

  it("should list supported providers in error for unsupported provider", () => {
    const ai = createAI({ openrouter: { apiKey: "test-key" } })

    expect(() => ai.getLanguageModel("unsupported:model")).toThrow(/Currently supported: openrouter/)
  })
})

describe("spend admission", () => {
  function spyOnProvider() {
    return spyOn(globalThis, "fetch").mockImplementation(
      (async () =>
        new Response(
          JSON.stringify({
            id: "gen_test",
            model: "openai/gpt-5.6-luna",
            choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )) as unknown as typeof globalThis.fetch
    )
  }

  it("should deny every method before the provider is called when the gate denies", async () => {
    const fetchSpy = spyOnProvider()
    try {
      const admit = mock(async (_request: SpendAdmissionRequest) => ({
        allowed: false as const,
        reason: "workspace_limit" as const,
      }))
      const ai = createAI({ openrouter: { apiKey: "test-key" }, spendGate: { admit } })
      const context = { workspaceId: "ws_123", userId: "usr_1" }
      const messages = [{ role: "user" as const, content: "test" }]

      const calls = [
        ai.generateText({ model: "openrouter:openai/gpt-5.6-luna", messages, context, telemetry: { functionId: "a" } }),
        ai.generateObject({
          model: "openrouter:openai/gpt-5.6-luna",
          schema: z.object({ answer: z.string() }),
          messages,
          context,
          telemetry: { functionId: "b" },
        }),
        ai.generateTextWithTools({
          model: ai.getLanguageModel("openrouter:openai/gpt-5.6-luna"),
          messages,
          tools: {},
          context,
          telemetry: { functionId: "c" },
        }),
        ai.embed({
          model: "openrouter:openai/text-embedding-3-small",
          value: "x",
          context,
          telemetry: { functionId: "d" },
        }),
        ai.embedMany({
          model: "openrouter:openai/text-embedding-3-small",
          values: ["x"],
          context,
          telemetry: { functionId: "e" },
        }),
        ai.generateDecisions({
          model: "openrouter:typesafe/jev-1.13",
          state: {},
          questions: { q: { type: "noul", instructions: "?" } },
          context,
          telemetry: { functionId: "f" },
        }),
      ]
      const results = await Promise.allSettled(calls)

      expect(results.map((r) => (r.status === "rejected" ? r.reason : r))).toEqual(
        ["a", "b", "c", "d", "e", "f"].map(() => expect.any(AISpendDeniedError))
      )
      expect(admit.mock.calls.map(([request]) => request)).toEqual(
        ["a", "b", "c", "d", "e", "f"].map((functionId) => ({ workspaceId: "ws_123", userId: "usr_1", functionId }))
      )
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it("should call the provider when the gate admits", async () => {
    const fetchSpy = spyOnProvider()
    try {
      const ai = createAI({
        openrouter: { apiKey: "test-key" },
        spendGate: { admit: async () => ({ allowed: true }) },
      })
      const result = await ai.generateText({
        model: "openrouter:openai/gpt-5.6-luna",
        messages: [{ role: "user", content: "test" }],
        context: { workspaceId: "ws_123" },
      })
      expect(result.value).toBe("ok")
    } finally {
      fetchSpy.mockRestore()
    }
  })
})

describe("generation reasoning and usage", () => {
  function openRouterResponse(content: string, usage: Record<string, unknown> = {}) {
    return new Response(
      JSON.stringify({
        id: "gen_test",
        model: "openai/gpt-5.6-luna",
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 6, total_tokens: 16, ...usage },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    )
  }

  it("forwards medium reasoning for text and omits reasoning options when unset", async () => {
    const bodies: Array<Record<string, unknown>> = []
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
      _input: Parameters<typeof globalThis.fetch>[0],
      init: Parameters<typeof globalThis.fetch>[1]
    ) => {
      bodies.push(JSON.parse(String(init?.body)))
      return openRouterResponse("ok")
    }) as unknown as typeof globalThis.fetch)
    try {
      const ai = createAI({ openrouter: { apiKey: "test-key" } })
      await ai.generateText({
        model: "openrouter:openai/gpt-5.6-luna",
        messages: [{ role: "user", content: "test" }],
        reasoningEffort: "medium",
      })
      await ai.generateText({
        model: "openrouter:openai/gpt-5.6-luna",
        messages: [{ role: "user", content: "test" }],
      })
      expect(bodies[0]?.reasoning).toEqual({ effort: "medium", exclude: true })
      expect(bodies[1]).not.toHaveProperty("reasoning")
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it("forwards medium reasoning for object generation", async () => {
    const bodies: Array<Record<string, unknown>> = []
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
      _input: Parameters<typeof globalThis.fetch>[0],
      init: Parameters<typeof globalThis.fetch>[1]
    ) => {
      bodies.push(JSON.parse(String(init?.body)))
      return openRouterResponse('{"answer":"ok"}')
    }) as unknown as typeof globalThis.fetch)
    try {
      const ai = createAI({ openrouter: { apiKey: "test-key" } })
      await ai.generateObject({
        model: "openrouter:openai/gpt-5.6-luna",
        schema: z.object({ answer: z.string() }),
        messages: [{ role: "user", content: "test" }],
        reasoningEffort: "medium",
      })
      expect(bodies[0]?.reasoning).toEqual({ effort: "medium", exclude: true })
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it("prefers standard reasoning-token details and falls back to OpenRouter metadata", () => {
    expect(
      extractUsageWithCost({
        usage: { outputTokenDetails: { reasoningTokens: 5 } },
        providerMetadata: {
          openrouter: { usage: { completionTokensDetails: { reasoningTokens: 3 } } },
        },
      }).reasoningTokens
    ).toBe(5)
    expect(
      extractUsageWithCost({
        usage: {},
        providerMetadata: {
          openrouter: { usage: { completionTokensDetails: { reasoningTokens: 3 } } },
        },
      }).reasoningTokens
    ).toBe(3)
  })

  it("extracts standard reasoning tokens and forwards them to the cost recorder", async () => {
    const recorded: Array<{ usage: { reasoningTokens?: number } }> = []
    const recordUsage = mock(async (params: { usage: { reasoningTokens?: number } }) => {
      recorded.push(params)
    })
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () =>
      openRouterResponse("ok", {
        completion_tokens_details: { reasoning_tokens: 4 },
      })) as unknown as typeof globalThis.fetch)
    try {
      const ai = createAI({ openrouter: { apiKey: "test-key" }, costRecorder: { recordUsage } })
      const result = await ai.generateText({
        model: "openrouter:openai/gpt-5.6-luna",
        messages: [{ role: "user", content: "test" }],
        context: { workspaceId: "ws_1" },
      })
      expect(result.usage.reasoningTokens).toBe(4)
      expect(recorded[0]?.usage.reasoningTokens).toBe(4)
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it("should time the provider call and forward the latency to the cost recorder", async () => {
    const recorded: Array<{ latencyMs?: number }> = []
    const recordUsage = mock(async (params: { latencyMs?: number }) => {
      recorded.push(params)
    })
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      return openRouterResponse("ok")
    }) as unknown as typeof globalThis.fetch)
    try {
      const ai = createAI({ openrouter: { apiKey: "test-key" }, costRecorder: { recordUsage } })
      await ai.generateText({
        model: "openrouter:openai/gpt-5.6-luna",
        messages: [{ role: "user", content: "test" }],
        context: { workspaceId: "ws_1" },
      })
      expect(recorded[0]?.latencyMs).toBeGreaterThanOrEqual(20)
    } finally {
      fetchSpy.mockRestore()
    }
  })
})

describe("GPT-6 Luna Responses", () => {
  const modelString = "openrouter:openai/gpt-6-luna"
  const usage = {
    input_tokens: 21,
    output_tokens: 9,
    total_tokens: 30,
    input_tokens_details: { cached_tokens: 4 },
    output_tokens_details: { reasoning_tokens: 3 },
    cost: 0.000042,
  }
  function reply(output: unknown[], reportedUsage: Record<string, unknown> = usage) {
    return new Response(
      JSON.stringify({
        id: "resp_test",
        created_at: 1730000000,
        model: "openai/gpt-6-luna",
        status: "completed",
        output,
        usage: reportedUsage,
      }),
      { headers: { "content-type": "application/json" } }
    )
  }
  const text = (value: string) => ({
    type: "message",
    id: "msg_test",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: value, annotations: [] }],
  })

  it("should use Chat Completions for tool-free calls and preserve usage after admission and disclosure", async () => {
    const requests: Array<{ path: string; body: any }> = []
    const events: string[] = []
    const recordUsage = mock(async (params: any) => {
      events.push("record")
      expect(params.usage).toEqual({
        promptTokens: 21,
        completionTokens: 9,
        totalTokens: 30,
        cachedPromptTokens: 4,
        reasoningTokens: 3,
        cost: 0.000042,
      })
    })
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: any, init: any) => {
      requests.push({ path: String(input), body: JSON.parse(init.body) })
      events.push("fetch")
      return new Response(
        JSON.stringify({
          id: "gen_test",
          choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
          usage: {
            prompt_tokens: 21,
            completion_tokens: 9,
            total_tokens: 30,
            cost: 0.000042,
            prompt_tokens_details: { cached_tokens: 4 },
            completion_tokens_details: { reasoning_tokens: 3 },
          },
        }),
        { headers: { "content-type": "application/json" } }
      )
    }) as typeof fetch)
    try {
      const ai = createAI({
        openrouter: { apiKey: "test-key" },
        costRecorder: { recordUsage },
        spendGate: {
          admit: async () => {
            events.push("admit")
            return { allowed: true }
          },
        },
        accessLogSink: {
          record: () => {
            events.push("disclose")
          },
        },
      })
      const result = await ai.generateText({
        model: modelString,
        messages: [{ role: "user", content: "hi" }],
        context: { workspaceId: "ws_1" },
      })
      await ai.generateText({ model: "openrouter:openai/gpt-5-mini", messages: [{ role: "user", content: "hi" }] })
      expect({ value: result.value, usage: result.usage, events, paths: requests.map((r) => r.path) }).toEqual({
        value: "hello",
        usage: {
          promptTokens: 21,
          completionTokens: 9,
          totalTokens: 30,
          cachedPromptTokens: 4,
          reasoningTokens: 3,
          cost: 0.000042,
        },
        events: ["admit", "disclose", "fetch", "record", "disclose", "fetch"],
        paths: ["https://openrouter.ai/api/v1/chat/completions", "https://openrouter.ai/api/v1/chat/completions"],
      })
      expect(requests.map((r) => ({ model: r.body.model, store: r.body.store, reasoning: r.body.reasoning }))).toEqual([
        { model: "openai/gpt-6-luna", store: undefined, reasoning: undefined },
        { model: "openai/gpt-5-mini", store: undefined, reasoning: undefined },
      ])
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it("should use Responses for structured output and keep exact cost accounting", async () => {
    let path = ""
    let body: Record<string, unknown> | undefined
    const recordUsage = mock(async () => {})
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: any, init: any) => {
      path = String(input)
      body = JSON.parse(init.body)
      return reply([text('{"answer":"ok"}')])
    }) as typeof fetch)
    try {
      const ai = createAI({ openrouter: { apiKey: "test-key" }, costRecorder: { recordUsage } })
      const result = await ai.generateObject({
        model: modelString,
        messages: [{ role: "user", content: "answer" }],
        schema: z.object({ answer: z.string() }),
        context: { workspaceId: "ws_1" },
      })
      expect({ path, model: body?.model, store: body?.store, value: result.value }).toEqual({
        path: "https://openrouter.ai/api/v1/responses",
        model: "openai/gpt-6-luna",
        store: false,
        value: { answer: "ok" },
      })
      expect(recordUsage).toHaveBeenCalledTimes(1)
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it("should send full two-step tool history without a server response pointer", async () => {
    const bodies: any[] = []
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (_input: any, init: any) => {
      bodies.push(JSON.parse(init.body))
      return bodies.length === 1
        ? reply([
            {
              type: "function_call",
              id: "fc_1",
              call_id: "call_1",
              name: "lookup",
              arguments: '{"query":"x"}',
              status: "completed",
            },
          ])
        : reply([text("found")])
    }) as typeof fetch)
    try {
      const ai = createAI({ openrouter: { apiKey: "test-key" } })
      const model = ai.getLanguageModel(modelString)
      await expect(
        ai.generateTextWithTools({ model, messages: [{ role: "user", content: "find x" }] })
      ).rejects.toThrow("require modelString")
      const tools = { lookup: tool({ inputSchema: z.object({ query: z.string() }), execute: async () => "result x" }) }
      const first = await ai.generateTextWithTools({
        model,
        modelString,
        messages: [{ role: "user", content: "find x" }],
        tools,
      })
      const second = await ai.generateTextWithTools({
        model,
        modelString,
        messages: [{ role: "user", content: "find x" }, ...first.response.messages],
        tools,
      })
      expect({ calls: first.toolCalls, answer: second.text, bodies }).toEqual({
        calls: [{ toolCallId: "call_1", toolName: "lookup", input: { query: "x" } }],
        answer: "found",
        bodies: [
          expect.objectContaining({ store: false, tools: [expect.objectContaining({ name: "lookup" })] }),
          expect.objectContaining({
            store: false,
            input: expect.arrayContaining([
              expect.objectContaining({ type: "function_call", call_id: "call_1" }),
              expect.objectContaining({ type: "function_call_output", call_id: "call_1" }),
            ]),
          }),
        ],
      })
      expect({ first: first.usage, second: second.usage }).toEqual({
        first: {
          promptTokens: 21,
          completionTokens: 9,
          totalTokens: 30,
          cachedPromptTokens: 4,
          reasoningTokens: 3,
          cost: 0.000042,
        },
        second: {
          promptTokens: 21,
          completionTokens: 9,
          totalTokens: 30,
          cachedPromptTokens: 4,
          reasoningTokens: 3,
          cost: 0.000042,
        },
      })
      expect(bodies[1]).not.toHaveProperty("previous_response_id")
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it("should fail a Responses tool call rather than record missing cost", async () => {
    const recordUsage = mock(async () => {})
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (_input: any, _init: any) =>
      reply([text("ok")], { ...usage, cost: undefined })) as typeof fetch)
    try {
      const ai = createAI({ openrouter: { apiKey: "test-key" }, costRecorder: { recordUsage } })
      await expect(
        ai.generateTextWithTools({
          model: ai.getLanguageModel(modelString),
          modelString,
          messages: [{ role: "user", content: "hi" }],
          context: { workspaceId: "ws_1" },
        })
      ).rejects.toThrow("exact usage.cost")
      expect(recordUsage).not.toHaveBeenCalled()
    } finally {
      fetchSpy.mockRestore()
    }
  })
})

describe("OpenRouter response fixtures", () => {
  // These fixtures were captured from real OpenRouter API calls on 2026-01-06
  // They document the expected response structure for cost tracking

  it("should have generateText fixture with cost data", () => {
    expect(fixtures.generateText.providerMetadata).toMatchObject({
      openrouter: {
        usage: {
          cost: 0.0000036,
          promptTokens: 16,
          completionTokens: 2,
          totalTokens: 18,
        },
      },
    })
  })

  it("should have generateObject fixture with cost data", () => {
    expect(fixtures.generateObject.providerMetadata).toMatchObject({
      openrouter: {
        usage: {
          cost: 0.00001545,
          promptTokens: 59,
          completionTokens: 11,
          totalTokens: 70,
        },
      },
    })
  })

  it("should have embed fixture with tokens and cost", () => {
    expect(fixtures.embed).toMatchObject({
      usage: { tokens: 4 },
      providerMetadata: {
        openrouter: {
          usage: { cost: 8e-8 },
        },
      },
    })
  })

  it("should have embedMany fixture with tokens and cost", () => {
    expect(fixtures.embedMany).toMatchObject({
      usage: { tokens: 3 },
      providerMetadata: {
        openrouter: {
          usage: { cost: 6e-8 },
        },
      },
    })
  })
})

describe("applyCacheBreakpoints", () => {
  const ANTHROPIC = "openrouter:anthropic/claude-sonnet-5"
  const EPHEMERAL = { openrouter: { cacheControl: { type: "ephemeral" } } }

  /**
   * Wire blocks Anthropic would count. Only a `tool` message fans a
   * message-level mark out per part — the provider gives a multi-part `user`
   * message's mark to its last text part, and accumulates assistant/system into
   * one wire message.
   */
  const countCacheBlocks = (messages: unknown[]): number =>
    messages.reduce<number>((n, m) => {
      const msg = m as { role: string; content: unknown; providerOptions?: unknown }
      const parts = Array.isArray(msg.content) ? (msg.content as Array<{ providerOptions?: unknown }>) : null
      if (msg.providerOptions) return n + (msg.role === "tool" && parts ? parts.length : 1)
      if (!parts) return n
      return n + parts.filter((p) => p.providerOptions).length
    }, 0)

  it("moves the system prompt into messages and breaks on it plus the newest message", () => {
    const result = applyCacheBreakpoints({
      system: "You are Ariadne.",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ],
      modelString: ANTHROPIC,
    })

    expect(result).toEqual({
      system: undefined,
      messages: [
        { role: "system", content: "You are Ariadne.", providerOptions: EPHEMERAL },
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello", providerOptions: EPHEMERAL },
      ],
    })
  })

  // The provider expands a tool message into one wire message PER RESULT and
  // copies the message-level cache_control onto every one of them. Four tools
  // called in one iteration meant 4 blocks + system = 5, and Anthropic rejects
  // the request at 5 — a hard 400 that killed the turn after the tools had
  // already run and written their state.
  it("marks one tool result, not the message, when a tool message fans out", () => {
    const toolResults = [
      {
        type: "tool-result",
        toolCallId: "c1",
        toolName: "update_user_settings",
        output: { type: "text", value: "ok" },
      },
      { type: "tool-result", toolCallId: "c2", toolName: "delegate_task", output: { type: "text", value: "ok" } },
      { type: "tool-result", toolCallId: "c3", toolName: "schedule_follow_up", output: { type: "text", value: "ok" } },
      { type: "tool-result", toolCallId: "c4", toolName: "save_memo", output: { type: "text", value: "ok" } },
    ]

    const result = applyCacheBreakpoints({
      system: "You are Ariadne.",
      messages: [{ role: "tool", content: toolResults } as never],
      modelString: ANTHROPIC,
    })

    const tool = result.messages.at(-1) as unknown as {
      providerOptions?: unknown
      content: Array<{ providerOptions?: unknown }>
    }
    // Message level would fan out to one block per result.
    expect(tool.providerOptions).toBeUndefined()
    expect(tool.content.map((p) => p.providerOptions)).toEqual([undefined, undefined, undefined, EPHEMERAL])
    expect(countCacheBlocks(result.messages)).toBe(2)
  })

  // A multi-part user message looks like it would fan out and does not: the
  // provider gives the message-level mark to the last TEXT part only. So it
  // keeps the message-level mark, and marking a part by hand would move the
  // breakpoint off the block the provider picked.
  it("leaves a multi-part user message marked at message level", () => {
    const result = applyCacheBreakpoints({
      system: "You are Ariadne.",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "look at this" },
            { type: "text", text: "and this" },
          ],
        } as never,
      ],
      modelString: ANTHROPIC,
    })

    const user = result.messages.at(-1) as { providerOptions?: unknown }
    expect(user.providerOptions).toEqual(EPHEMERAL)
    expect(countCacheBlocks(result.messages)).toBe(2)
  })

  // assistant and system accumulate into a single wire message, so a part-level
  // mark there would be read by nothing.
  it("keeps the message-level mark for roles that do not fan out", () => {
    const result = applyCacheBreakpoints({
      messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] } as never],
      modelString: ANTHROPIC,
    })

    expect((result.messages.at(-1) as { providerOptions?: unknown }).providerOptions).toEqual(EPHEMERAL)
  })

  it("places a single breakpoint when the system prompt is the only message", () => {
    const result = applyCacheBreakpoints({ system: "Prompt.", messages: [], modelString: ANTHROPIC })

    expect(result).toEqual({
      system: undefined,
      messages: [{ role: "system", content: "Prompt.", providerOptions: EPHEMERAL }],
    })
  })

  it("breaks on the newest message when there is no system prompt", () => {
    const result = applyCacheBreakpoints({
      messages: [{ role: "user", content: "hi" }],
      modelString: ANTHROPIC,
    })

    expect(result).toEqual({
      system: undefined,
      messages: [{ role: "user", content: "hi", providerOptions: EPHEMERAL }],
    })
  })

  // A shallow spread over providerOptions would replace the whole `openrouter`
  // key and silently drop sibling options such as reasoning effort.
  it("merges alongside sibling openrouter options rather than replacing them", () => {
    const result = applyCacheBreakpoints({
      messages: [
        {
          role: "user",
          content: "hi",
          providerOptions: { openrouter: { reasoning: { effort: "high" } }, anthropic: { foo: "bar" } },
        },
      ],
      modelString: ANTHROPIC,
    })

    expect(result.messages[0]?.providerOptions).toEqual({
      anthropic: { foo: "bar" },
      openrouter: { reasoning: { effort: "high" }, cacheControl: { type: "ephemeral" } },
    })
  })

  // Measured 2026-07-26: Gemini caches the marked prefix and caches nothing
  // without the marker, exactly like Anthropic.
  it("breaks on Gemini too, which also requires an explicit marker", () => {
    const result = applyCacheBreakpoints({
      system: "Prompt.",
      messages: [{ role: "user", content: "hi" }],
      modelString: "openrouter:google/gemini-2.5-pro",
    })

    expect(result.messages.map((m) => m.providerOptions)).toEqual([EPHEMERAL, EPHEMERAL])
  })

  // OpenAI caching is automatic and needs no marker; personas may run any
  // registry model, and losing the optimization is the correct degradation.
  it("leaves the request untouched for providers that need no marker", () => {
    const request = {
      system: "Prompt.",
      messages: [{ role: "user" as const, content: "hi" }],
      modelString: "openrouter:openai/gpt-5.6-luna",
    }

    expect(applyCacheBreakpoints(request)).toEqual({ system: request.system, messages: request.messages })
  })

  it("leaves the request untouched when no model string is available", () => {
    const request = { system: "Prompt.", messages: [{ role: "user" as const, content: "hi" }] }

    expect(applyCacheBreakpoints(request)).toEqual({ system: request.system, messages: request.messages })
  })
})

describe("applyCacheBreakpoints — volatile system tail", () => {
  const ANTHROPIC = "openrouter:anthropic/claude-sonnet-5"
  const EPHEMERAL = { openrouter: { cacheControl: { type: "ephemeral" } } }

  // The whole point of the split: per-turn content sits AFTER the breakpoint, so
  // changing it leaves the cached prefix (tools + stable system) reusable.
  it("emits the volatile tail as an unmarked system message after the breakpoint", () => {
    const result = applyCacheBreakpoints({
      system: "You are Ariadne.",
      volatileSystem: "## Current Time\n\n10:00",
      messages: [{ role: "user", content: "hi" }],
      modelString: ANTHROPIC,
    })

    expect(result.messages).toEqual([
      { role: "system", content: "You are Ariadne.", providerOptions: EPHEMERAL },
      { role: "system", content: "## Current Time\n\n10:00" },
      { role: "user", content: "hi", providerOptions: EPHEMERAL },
    ])
  })

  // Caching the volatile message would pay a write premium every turn for a span
  // that can never be reused, since its content changes every turn.
  it("never places the second breakpoint on the volatile message", () => {
    const result = applyCacheBreakpoints({
      system: "You are Ariadne.",
      volatileSystem: "## Current Time\n\n10:00",
      messages: [],
      modelString: ANTHROPIC,
    })

    expect(result.messages).toEqual([
      { role: "system", content: "You are Ariadne.", providerOptions: EPHEMERAL },
      { role: "system", content: "## Current Time\n\n10:00" },
    ])
  })

  // Dropping the tail would silently strip temporal grounding from the prompt.
  it("rejoins both halves when the provider takes no breakpoint", () => {
    const result = applyCacheBreakpoints({
      system: "You are Ariadne.",
      volatileSystem: "## Current Time\n\n10:00",
      messages: [{ role: "user", content: "hi" }],
      modelString: "openrouter:openai/gpt-5.6-luna",
    })

    expect(result).toEqual({
      system: "You are Ariadne.\n\n## Current Time\n\n10:00",
      messages: [{ role: "user", content: "hi" }],
    })
  })
})
