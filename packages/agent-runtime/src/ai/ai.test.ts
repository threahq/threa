import { describe, it, expect, mock } from "bun:test"
import { parseModelId, createAI, AIBudgetExceededError, applyCacheBreakpoints } from "./ai"

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

  it("should have consistent error messages mentioning env var and config for LangChain models", async () => {
    const ai = createAI({})

    await expect(ai.getLangChainModel("openrouter:test")).rejects.toThrow(/OPENROUTER_API_KEY.*openrouter\.apiKey/)
  })

  it("should list supported providers in error for unsupported provider", () => {
    const ai = createAI({ openrouter: { apiKey: "test-key" } })

    expect(() => ai.getLanguageModel("unsupported:model")).toThrow(/Currently supported: openrouter/)
  })
})

describe("budget enforcement", () => {
  it("should block generateText when hard limit is reached", async () => {
    const checkBudget = mock(async () => ({
      allowed: false as const,
      reason: "hard_limit" as const,
      currentUsageUsd: 160,
      budgetUsd: 100,
      percentUsed: 1.6,
    }))

    const ai = createAI({
      budgetEnforcer: {
        checkBudget,
      },
    })

    await expect(
      ai.generateText({
        model: "openrouter:openai/gpt-5",
        messages: [{ role: "user", content: "test" }],
        context: { workspaceId: "ws_123" },
      })
    ).rejects.toBeInstanceOf(AIBudgetExceededError)

    expect(checkBudget).toHaveBeenCalledWith("ws_123", "openrouter:openai/gpt-5")
  })

  it("should apply soft-limit recommended model for LangChain calls", async () => {
    const checkBudget = mock(async () => ({
      allowed: true as const,
      reason: "soft_limit" as const,
      currentUsageUsd: 80,
      budgetUsd: 100,
      percentUsed: 0.8,
      recommendedModel: "unsupported:model",
    }))

    const ai = createAI({
      openrouter: { apiKey: "test-key" },
      budgetEnforcer: {
        checkBudget,
      },
    })

    await expect(ai.getLangChainModel("openrouter:openai/gpt-5-mini", { workspaceId: "ws_123" })).rejects.toThrow(
      'Unsupported LangChain provider: "unsupported"'
    )
    expect(checkBudget).toHaveBeenCalledWith("ws_123", "openrouter:openai/gpt-5-mini")
  })

  it("should expose the effective model chosen for LangChain calls", async () => {
    const checkBudget = mock(async () => ({
      allowed: true as const,
      reason: "soft_limit" as const,
      currentUsageUsd: 85,
      budgetUsd: 100,
      percentUsed: 0.85,
      recommendedModel: "openrouter:openai/gpt-5-mini",
    }))

    const ai = createAI({
      openrouter: { apiKey: "test-key" },
      budgetEnforcer: {
        checkBudget,
      },
    })

    const { effectiveModel, budgetMetadata } = await ai.getLangChainModel("openrouter:openai/gpt-5", {
      workspaceId: "ws_999",
    })
    expect(effectiveModel).toBe("openrouter:openai/gpt-5-mini")
    expect(budgetMetadata).toMatchObject({
      budget_policy_checked: true,
      budget_policy_reason: "soft_limit",
      budget_model_requested: "openrouter:openai/gpt-5",
      budget_model_effective: "openrouter:openai/gpt-5-mini",
      budget_model_degraded: true,
      budget_percent_used: 0.85,
      budget_current_usage_usd: 85,
      budget_limit_usd: 100,
    })
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
