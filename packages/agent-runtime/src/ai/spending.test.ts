import { describe, expect, it } from "bun:test"
import { createOpenRouter } from "@openrouter/ai-sdk-provider"
import { embed as rawEmbed, generateText as rawGenerateText, tool } from "ai"
import { z } from "zod"
import { AI_SPENDING_COVERAGE } from "@threahq/types"
import { createAI, type AI, type AccessLogSink, type BudgetEnforcer, type CostRecorder } from "./ai"
import {
  OPENROUTER_CHAT_COMPLETIONS_URL,
  SpendingDeniedError,
  SpendingDuplicateRequestError,
  SpendingExecutionLostError,
  SpendingOutcomeUnknownError,
  createGuardedFetch,
  parseReceipt,
  providerRouting,
  quoteAttempt,
  validateWireBody,
  type SpendingRequest,
  type SpendingDispatchOutcome,
  type SpendingGate,
  type SpendingPolicyMode,
  type SpendingReserveOutcome,
  type SpendingRouteProfile,
} from "./spending"

/**
 * Conservative text-only envelope for openai/gpt-5.6-luna pinned to the
 * `openai` endpoint (public endpoint record, 2026-09-16): prompt bound at the
 * long-context cache-write rate over the full published prompt maximum,
 * completion at the long-context rate. Contract evidence only — no route is
 * activated by this profile.
 */
const LUNA_OPENAI: SpendingRouteProfile = AI_SPENDING_COVERAGE.route

const MODEL = "openrouter:openai/gpt-5.6-luna"

function spendingFor(workspaceId: string, userId = "usr_1"): SpendingRequest {
  return {
    workspaceId,
    userId,
    sessionId: "sess_1",
    executionGeneration: 1,
    operationId: "op_1",
    purpose: "assistant_turn",
    requestKey: "step_1",
  }
}

type GateCall =
  | { kind: "routeFor"; modelId: string; workspaceId: string }
  | { kind: "reserve"; request: Parameters<SpendingGate["reserve"]>[0] }
  | { kind: "dispatch"; workspaceId: string; attemptId: string }
  | { kind: "settle"; params: Parameters<SpendingGate["settle"]>[0] }
  | { kind: "release"; workspaceId: string; attemptId: string }
  | { kind: "markUnknown"; workspaceId: string; attemptId: string }
  | { kind: "fetch"; body: Record<string, unknown> }

interface FakeGateOptions {
  reserve?: (request: Parameters<SpendingGate["reserve"]>[0]) => SpendingReserveOutcome
  dispatch?: () => SpendingDispatchOutcome
  settle?: () => Promise<void>
  routeFor?: (modelId: string) => SpendingRouteProfile | null
  /** Defaults to an enforced workspace. */
  policyMode?: (workspaceId: string) => SpendingPolicyMode | Promise<SpendingPolicyMode>
}

function fakeGate(calls: GateCall[], options: FakeGateOptions = {}): SpendingGate {
  let nextAttempt = 1
  return {
    async policyMode(workspaceId) {
      return options.policyMode ? options.policyMode(workspaceId) : { mode: "protected", denial: null }
    },
    async routeFor({ context, modelId }) {
      calls.push({ kind: "routeFor", modelId, workspaceId: context.workspaceId })
      if (options.routeFor) return options.routeFor(modelId)
      return modelId === LUNA_OPENAI.model ? LUNA_OPENAI : null
    },
    async reserve(request) {
      calls.push({ kind: "reserve", request })
      if (options.reserve) return options.reserve(request)
      return { allowed: true, created: true, attempt: { id: `att_${nextAttempt++}`, state: "reserved" } }
    },
    async dispatch(workspaceId, attemptId) {
      calls.push({ kind: "dispatch", workspaceId, attemptId })
      return options.dispatch ? options.dispatch() : { dispatched: true }
    },
    async settle(params) {
      calls.push({ kind: "settle", params })
      if (options.settle) await options.settle()
    },
    async release(workspaceId, attemptId) {
      calls.push({ kind: "release", workspaceId, attemptId })
    },
    async markUnknown(workspaceId, attemptId) {
      calls.push({ kind: "markUnknown", workspaceId, attemptId })
    },
  }
}

function openRouterBody(
  content: string,
  usage: Record<string, unknown> | null = {},
  extra: Record<string, unknown> = {}
) {
  return {
    id: "gen-abc123",
    model: LUNA_OPENAI.model,
    provider: "OpenAI",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    ...(usage === null
      ? {}
      : { usage: { prompt_tokens: 10, completion_tokens: 6, total_tokens: 16, cost: 0.0000132, ...usage } }),
    ...extra,
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

type FetchHandler = (body: Record<string, unknown>) => Promise<Response> | Response

function fakeFetch(
  calls: GateCall[],
  handler: FetchHandler
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  return async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    calls.push({ kind: "fetch", body })
    return handler(body)
  }
}

function kinds(calls: GateCall[]): string[] {
  return calls.map((call) => call.kind)
}

async function unknownOutcome(promise: Promise<unknown>): Promise<SpendingOutcomeUnknownError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof SpendingOutcomeUnknownError) return error
    throw error
  }
  throw new Error("expected a SpendingOutcomeUnknownError")
}

async function duplicate(promise: Promise<unknown>): Promise<SpendingDuplicateRequestError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof SpendingDuplicateRequestError) return error
    throw error
  }
  throw new Error("expected a SpendingDuplicateRequestError")
}

async function denial(promise: Promise<unknown>): Promise<SpendingDeniedError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof SpendingDeniedError) return error
    throw error
  }
  throw new Error("expected a SpendingDeniedError")
}

describe("quoteAttempt", () => {
  it("bounds the attempt at the published prompt maximum plus the requested completion cap, exactly", () => {
    expect(quoteAttempt(LUNA_OPENAI, 8192)).toEqual({
      model: LUNA_OPENAI.model,
      providerRoute: "openai",
      maxTokens: 8192,
      maxCostUsd: "0.4757456",
    })
    expect(quoteAttempt(LUNA_OPENAI, undefined).maxCostUsd).toBe("0.6914")
    expect(
      quoteAttempt(
        { ...LUNA_OPENAI, promptUsdPerToken: "0.000000125", completionUsdPerToken: "1e-10", maxPromptTokens: 3 },
        7
      ).maxCostUsd
    ).toBe("0.00000039")
    expect(quoteAttempt({ ...LUNA_OPENAI, requestUsd: "0.005" }, 8192).maxCostUsd).toBe("0.4807456")
  })

  it("refuses completion caps outside the endpoint envelope", () => {
    for (const bad of [0, -1, 1.5, 128_001, Number.NaN]) {
      expect(() => quoteAttempt(LUNA_OPENAI, bad)).toThrow(SpendingDeniedError)
    }
  })

  it("refuses a profile whose bounds or rates cannot produce a storable quote", () => {
    const cases: Array<[string, Partial<SpendingRouteProfile>]> = [
      ["model", { model: "" }],
      ["providerSlug", { providerSlug: "" }],
      ["maxPromptTokens", { maxPromptTokens: 0 }],
      ["maxPromptTokens", { maxPromptTokens: Number.MAX_SAFE_INTEGER + 1 }],
      ["maxCompletionTokens", { maxCompletionTokens: 1.5 }],
      ["promptUsdPerToken", { promptUsdPerToken: "0" }],
      ["promptUsdPerToken", { promptUsdPerToken: "-0.0000005" }],
      ["completionUsdPerToken", { completionUsdPerToken: "1e999" }],
      ["completionUsdPerToken", { completionUsdPerToken: "abc" }],
      ["requestUsd", { requestUsd: "-1" }],
      ["requestUsd", { requestUsd: "1e-3" }],
      ["maxCostUsd", { promptUsdPerToken: "999999", maxPromptTokens: 1_000_000_000 }],
    ]
    for (const [field, override] of cases) {
      let caught: unknown
      try {
        quoteAttempt({ ...LUNA_OPENAI, ...override }, 8192)
      } catch (error) {
        caught = error
      }
      expect(caught).toBeInstanceOf(SpendingDeniedError)
      expect({
        code: (caught as SpendingDeniedError).code,
        field: (caught as SpendingDeniedError).details.field,
      }).toEqual({
        code: "UNKNOWN_ROUTE",
        field,
      })
    }
  })
})

describe("validateWireBody", () => {
  const quote = quoteAttempt(LUNA_OPENAI, 8192)
  const good = () => ({
    model: LUNA_OPENAI.model,
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    max_tokens: 8192,
    usage: { include: true },
    provider: providerRouting(LUNA_OPENAI),
    tools: [{ type: "function", function: { name: "f", parameters: {} } }],
    reasoning: { effort: "medium", exclude: true },
  })

  it("accepts the quoted text-only tools request", () => {
    expect(() => validateWireBody(good(), LUNA_OPENAI, quote)).not.toThrow()
  })

  it("rejects every widening of the final body before reserve", () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["model", { ...good(), model: "openai/gpt-5.6" }],
      ["models", { ...good(), models: ["openai/gpt-5.6"] }],
      ["plugins", { ...good(), plugins: [{ id: "web" }] }],
      ["web_search_options", { ...good(), web_search_options: {} }],
      ["service_tier", { ...good(), service_tier: "fast" }],
      ["stream", { ...good(), stream: true }],
      ["n", { ...good(), n: 2 }],
      ["response_format", { ...good(), response_format: { type: "json_object" } }],
      ["temperature", { ...good(), temperature: 0.2 }],
      ["top_p", { ...good(), top_p: 0.9 }],
      ["parallel_tool_calls", { ...good(), parallel_tool_calls: true }],
      ["max_tokens", { ...good(), max_tokens: 8193 }],
      ["max_tokens", { ...good(), max_tokens: undefined }],
      ["usage", { ...good(), usage: { include: false } }],
      ["provider.allow_fallbacks", { ...good(), provider: { ...providerRouting(LUNA_OPENAI), allow_fallbacks: true } }],
      ["provider.order", { ...good(), provider: { ...providerRouting(LUNA_OPENAI), order: ["azure"] } }],
      ["provider.require_parameters", { ...good(), provider: { order: ["openai"], allow_fallbacks: false } }],
      ["provider.only", { ...good(), provider: { ...providerRouting(LUNA_OPENAI), only: ["openai"] } }],
      [
        "messages[0].content[0]",
        { ...good(), messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:x" } }] }] },
      ],
      [
        "messages[0].content[1]",
        { ...good(), messages: [{ role: "user", content: [{ type: "text", text: "a" }, { type: "file" }] }] },
      ],
      ["tools[0]", { ...good(), tools: [{ type: "web_search" }] }],
      [
        "tools[0].cache_control",
        { ...good(), tools: [{ type: "function", function: { name: "f" }, cache_control: { type: "ephemeral" } }] },
      ],
      [
        "tools[0].function.web_search",
        { ...good(), tools: [{ type: "function", function: { name: "f", web_search: true } }] },
      ],
      [
        "messages[0].content[0].image_url",
        {
          ...good(),
          messages: [{ role: "user", content: [{ type: "text", text: "a", image_url: { url: "data:x" } }] }],
        },
      ],
      ["reasoning.max_tokens", { ...good(), reasoning: { effort: "high", max_tokens: 1 } }],
      ["provider.max_price", { ...good(), provider: { ...providerRouting(LUNA_OPENAI), max_price: { prompt: "9" } } }],
      ["messages[0].input_audio", { ...good(), messages: [{ role: "user", content: "a", input_audio: {} }] }],
      ["messages[0]", { ...good(), messages: [{ role: "function", content: "a" }] }],
    ]
    for (const [field, body] of cases) {
      let caught: unknown
      try {
        validateWireBody(body, LUNA_OPENAI, quote)
      } catch (error) {
        caught = error
      }
      expect(caught).toBeInstanceOf(SpendingDeniedError)
      expect({
        code: (caught as SpendingDeniedError).code,
        field: (caught as SpendingDeniedError).details.field,
      }).toEqual({
        code: "REQUEST_NOT_BOUNDED",
        field,
      })
    }
  })
})

describe("approved route parameters", () => {
  it("should reject an unsupported temperature before reserving or sending through the installed SDK", async () => {
    const calls: GateCall[] = []
    const ai = createAI({
      openrouter: { apiKey: "test", fetch: fakeFetch(calls, () => jsonResponse(openRouterBody("reply"))) },
      spendingGate: fakeGate(calls),
    })
    await expect(
      ai.generateTextWithTools({
        model: ai.getLanguageModel(MODEL),
        modelString: MODEL,
        messages: [{ role: "user", content: "Hello" }],
        tools: {},
        temperature: 0.7,
        context: { workspaceId: "ws_1", userId: "usr_1" },
        spending: spendingFor("ws_1"),
      })
    ).rejects.toMatchObject({ code: "REQUEST_NOT_BOUNDED", details: { field: "temperature" } })
    expect(kinds(calls)).toEqual(["routeFor"])
  })
})

describe("parseReceipt", () => {
  it("keeps only the generation id and whitelisted token counts", () => {
    const { receipt, costUsd } = parseReceipt(
      JSON.stringify(
        openRouterBody("secret answer", {
          prompt_tokens_details: { cached_tokens: 4, audio_tokens: 1 },
          completion_tokens_details: { reasoning_tokens: 2 },
          cost_details: { upstream_inference_cost: 0.00001 },
        })
      )
    )
    expect({ receipt, costUsd }).toEqual({
      receipt: {
        providerRequestId: "gen-abc123",
        usage: { prompt_tokens: 10, completion_tokens: 6, total_tokens: 16, cached_tokens: 4, reasoning_tokens: 2 },
      },
      costUsd: "0.0000132",
    })
    expect(JSON.stringify(receipt)).not.toContain("secret answer")
  })

  it("reports no cost for missing, negative, non-numeric, unstorable or unparsable usage", () => {
    for (const usage of [null, { cost: "0.1" }, { cost: -1 }, { cost: 1e13 }, { cost: 5e-324 }, { cost: null }]) {
      expect(parseReceipt(JSON.stringify(openRouterBody("x", usage))).costUsd).toBeNull()
    }
    expect(parseReceipt("<html>")).toEqual({ receipt: { providerRequestId: null, usage: {} }, costUsd: null })
  })

  it("rounds up from the exact JSON cost literal, not from the double JSON.parse would produce", () => {
    const withCost = (literal: string) =>
      parseReceipt(`{"id":"gen-1","usage":{"prompt_tokens":10,"completion_tokens":6,"cost":${literal}}}`).costUsd
    // Each literal parses to a double that is exactly 1e-8 or 0.5, which would round to the understated value.
    expect(Number("0.0000000100000000000000001")).toBe(1e-8)
    expect(withCost("0.0000000100000000000000001")).toBe("0.00000002")
    expect(Number("1.00000000000000000001e-8")).toBe(1e-8)
    expect(withCost("1.00000000000000000001e-8")).toBe("0.00000002")
    expect(withCost("100000000000000000001E-28")).toBe("0.00000002")
    expect(Number("0.50000000000000000001")).toBe(0.5)
    expect(withCost("0.50000000000000000001")).toBe("0.50000001")
    expect(withCost("0.12345678")).toBe("0.12345678")
  })

  it("follows JSON semantics for duplicate, quoted and nested cost keys", () => {
    const parse = (text: string) => parseReceipt(text).costUsd
    // JSON.parse keeps the last duplicate; the charge must be that value's literal.
    expect(parse(`{"usage":{"completion_tokens":5,"cost":0.000000010000000000001,"cost":0.25}}`)).toBe("0.25")
    expect(parse(`{"usage":{"completion_tokens":5,"cost":0.25,"cost":0.000000010000000000001}}`)).toBe("0.00000002")
    expect(parse(`{"usage":{"completion_tokens":5,"cost":0.9},"usage":{"completion_tokens":5}}`)).toBeNull()
    expect(parse(`{"usage":{"completion_tokens":5,"cost":"0.9"}}`)).toBeNull()
    expect(parse(`{"usage":{"completion_tokens":5,"cost_details":{"cost":0.9}}}`)).toBeNull()
    expect(
      parse(
        `{"choices":[{"message":{"content":"\\"usage\\":{\\"cost\\":9}","cost":9}}],"cost":9,"usage":{"completion_tokens":5,"cost":1e-8}}`
      )
    ).toBe("0.00000001")
  })

  it("holds rather than trusts a zero charge against billed tokens or a BYOK fee", () => {
    const parse = (usage: string) => parseReceipt(`{"id":"gen-1","usage":${usage}}`)
    expect(parse(`{"prompt_tokens":10,"completion_tokens":0,"cost":0}`).costUsd).toBeNull()
    expect(parse(`{"prompt_tokens":0,"completion_tokens":0,"cost":0}`).costUsd).toBe("0")
    expect(parse(`{"prompt_tokens":10,"completion_tokens":6,"cost":0.00001,"is_byok":true}`).costUsd).toBeNull()
    expect(
      parse(
        `{"prompt_tokens":10,"completion_tokens":6,"cost":0.00001,"prompt_tokens_details":{"cached_tokens":2,"cache_write_tokens":8},"completion_tokens_details":{"reasoning_tokens":4}}`
      )
    ).toEqual({
      receipt: {
        providerRequestId: "gen-1",
        usage: {
          prompt_tokens: 10,
          completion_tokens: 6,
          cached_tokens: 2,
          cache_write_tokens: 8,
          reasoning_tokens: 4,
        },
      },
      costUsd: "0.00001",
    })
  })
})

describe("guarded transport through the installed SDK", () => {
  function guardedAI(calls: GateCall[], handler: FetchHandler, gateOptions: FakeGateOptions = {}) {
    return createAI({
      openrouter: { apiKey: "test-key", fetch: fakeFetch(calls, handler) },
      spendingGate: fakeGate(calls, gateOptions),
    })
  }

  it("sends exactly one pinned request and settles the rounded-up provider charge", async () => {
    const calls: GateCall[] = []
    const ai = guardedAI(calls, () => jsonResponse(openRouterBody("hello", { cost: 0.0000132 })))
    const result = await ai.generateTextWithTools({
      model: ai.getLanguageModel(MODEL),
      modelString: MODEL,
      system: "be brief",
      messages: [{ role: "user", content: "hi" }],
      tools: { lookup: tool({ description: "lookup", inputSchema: z.object({ q: z.string() }) }) },
      maxTokens: 8192,
      spending: spendingFor("ws_a"),
    })

    expect(result.text).toBe("hello")
    expect(kinds(calls)).toEqual(["routeFor", "reserve", "dispatch", "fetch", "settle"])
    const reserve = calls[1] as Extract<GateCall, { kind: "reserve" }>
    expect(reserve.request).toEqual({
      workspaceId: "ws_a",
      idempotencyKey: "op:4:op_1:req:step_1",
      sponsorUserId: "usr_1",
      sessionId: "sess_1",
      operationId: "op_1",
      purpose: "assistant_turn",
      stage: "agent",
      model: LUNA_OPENAI.model,
      providerRoute: "openai",
      provider: "openrouter",
      functionId: "generateTextWithTools",
      maxCostUsd: "0.4757456",
    })
    const wire = (calls[3] as Extract<GateCall, { kind: "fetch" }>).body
    expect({
      model: wire.model,
      max_tokens: wire.max_tokens,
      usage: wire.usage,
      provider: wire.provider,
      toolNames: (wire.tools as Array<{ function: { name: string } }>).map((t) => t.function.name),
      models: wire.models,
      plugins: wire.plugins,
      stream: wire.stream,
    }).toEqual({
      model: LUNA_OPENAI.model,
      max_tokens: 8192,
      usage: { include: true },
      provider: {
        order: ["openai"],
        allow_fallbacks: false,
        require_parameters: true,
        max_price: { prompt: "0.5", completion: "1.8" },
      },
      toolNames: ["lookup"],
      models: undefined,
      plugins: undefined,
      stream: undefined,
    })
    expect((calls[4] as Extract<GateCall, { kind: "settle" }>).params).toEqual({
      workspaceId: "ws_a",
      attemptId: "att_1",
      actualCostUsd: "0.0000132",
      receipt: {
        providerRequestId: "gen-abc123",
        usage: { prompt_tokens: 10, completion_tokens: 6, total_tokens: 16 },
      },
    })
  })

  it("uses the endpoint completion maximum when the caller sets no cap and forwards reasoning effort", async () => {
    const calls: GateCall[] = []
    const ai = guardedAI(calls, () => jsonResponse(openRouterBody("ok")))
    await ai.generateText({
      model: MODEL,
      messages: [{ role: "user", content: "hi" }],
      reasoningEffort: "low",
      spending: spendingFor("ws_a"),
    })
    const wire = (calls[3] as Extract<GateCall, { kind: "fetch" }>).body
    expect({ max_tokens: wire.max_tokens, reasoning: wire.reasoning }).toEqual({
      max_tokens: 128_000,
      reasoning: { effort: "low", exclude: true },
    })
    expect((calls[1] as Extract<GateCall, { kind: "reserve" }>).request.maxCostUsd).toBe("0.6914")
  })

  it("denies at the ledger with zero egress and nothing to release", async () => {
    const calls: GateCall[] = []
    const ai = guardedAI(calls, () => jsonResponse(openRouterBody("never")), {
      reserve: () => ({
        allowed: false,
        reason: "LIMIT_EXCEEDED",
        stage: "agent",
        cutoffUsd: "5",
        settledUsd: "4.8",
        committedUsd: "0",
      }),
    })
    const error = await denial(
      ai.generateText({ model: MODEL, messages: [{ role: "user", content: "hi" }], spending: spendingFor("ws_a") })
    )
    expect({ code: error.code, details: error.details }).toEqual({
      code: "LIMIT_EXCEEDED",
      details: { stage: "agent", cutoffUsd: "5", settledUsd: "4.8", committedUsd: "0", maxCostUsd: "0.6914" },
    })
    expect(kinds(calls)).toEqual(["routeFor", "reserve"])
  })

  it("releases a reservation the dispatch recheck refuses, and never sends", async () => {
    const calls: GateCall[] = []
    const ai = guardedAI(calls, () => jsonResponse(openRouterBody("never")), {
      dispatch: () => ({ dispatched: false, reason: "EMERGENCY" }),
    })
    const error = await denial(
      ai.generateText({ model: MODEL, messages: [{ role: "user", content: "hi" }], spending: spendingFor("ws_a") })
    )
    expect(error.code).toBe("EMERGENCY")
    expect(kinds(calls)).toEqual(["routeFor", "reserve", "dispatch", "release"])
  })

  it("reports a lost dispatch race as a typed duplicate and releases nothing", async () => {
    const calls: GateCall[] = []
    const ai = guardedAI(calls, () => jsonResponse(openRouterBody("never")), {
      dispatch: () => ({ dispatched: false, reason: "NOT_RESERVED", state: "dispatched" }),
    })
    const error = await duplicate(
      ai.generateText({ model: MODEL, messages: [{ role: "user", content: "hi" }], spending: spendingFor("ws_a") })
    )
    expect({ code: error.code, attemptId: error.attemptId, state: error.state }).toEqual({
      code: "DUPLICATE_REQUEST",
      attemptId: "att_1",
      state: "dispatched",
    })
    expect(kinds(calls)).toEqual(["routeFor", "reserve", "dispatch"])
  })

  it("sends nothing when the request key already names a dispatched, unknown, settled or released attempt", async () => {
    for (const state of ["dispatched", "unknown", "settled", "released"] as const) {
      const calls: GateCall[] = []
      const ai = guardedAI(calls, () => jsonResponse(openRouterBody("never")), {
        reserve: () => ({ allowed: true, created: false, attempt: { id: "att_owner", state } }),
      })
      const error = await duplicate(
        ai.generateText({ model: MODEL, messages: [{ role: "user", content: "hi" }], spending: spendingFor("ws_a") })
      )
      expect({ state: error.state, attemptId: error.attemptId, calls: kinds(calls) }).toEqual({
        state,
        attemptId: "att_owner",
        calls: ["routeFor", "reserve"],
      })
    }
  })

  it("sends a still-reserved attempt it did not create once, but never releases it on refusal", async () => {
    const reserveExisting = () =>
      ({ allowed: true, created: false, attempt: { id: "att_owner", state: "reserved" } }) as const
    const sent: GateCall[] = []
    const recovering = guardedAI(sent, () => jsonResponse(openRouterBody("ok")), { reserve: reserveExisting })
    await recovering.generateText({
      model: MODEL,
      messages: [{ role: "user", content: "hi" }],
      spending: spendingFor("ws_a"),
    })
    expect(kinds(sent)).toEqual(["routeFor", "reserve", "dispatch", "fetch", "settle"])

    const refused: GateCall[] = []
    const ai = guardedAI(refused, () => jsonResponse(openRouterBody("never")), {
      reserve: reserveExisting,
      dispatch: () => ({ dispatched: false, reason: "DISABLED" }),
    })
    const error = await denial(
      ai.generateText({ model: MODEL, messages: [{ role: "user", content: "hi" }], spending: spendingFor("ws_a") })
    )
    expect({ code: error.code, calls: kinds(refused) }).toEqual({
      code: "DISABLED",
      calls: ["routeFor", "reserve", "dispatch"],
    })
  })

  it("surfaces a dispatch-time limit refusal with its amounts and releases its own reservation", async () => {
    const calls: GateCall[] = []
    const ai = guardedAI(calls, () => jsonResponse(openRouterBody("never")), {
      dispatch: () => ({
        dispatched: false,
        reason: "LIMIT_EXCEEDED",
        stage: "agent",
        cutoffUsd: "0",
        settledUsd: "0",
        committedUsd: "0.6914",
      }),
    })
    const error = await denial(
      ai.generateText({ model: MODEL, messages: [{ role: "user", content: "hi" }], spending: spendingFor("ws_a") })
    )
    expect({ code: error.code, details: error.details, calls: kinds(calls) }).toEqual({
      code: "LIMIT_EXCEEDED",
      details: {
        stage: "agent",
        cutoffUsd: "0",
        settledUsd: "0",
        committedUsd: "0.6914",
        attemptId: "att_1",
        maxCostUsd: "0.6914",
      },
      calls: ["routeFor", "reserve", "dispatch", "release"],
    })
  })

  it("passes the captured generation to dispatch and stops a lost execution without sending or releasing", async () => {
    const calls: GateCall[] = []
    const generations: Array<number | null> = []
    const ai = createAI({
      openrouter: { apiKey: "test-key", fetch: fakeFetch(calls, () => jsonResponse(openRouterBody("never"))) },
      spendingGate: {
        ...fakeGate(calls),
        dispatch: async (workspaceId, attemptId, generation) => {
          calls.push({ kind: "dispatch", workspaceId, attemptId })
          generations.push(generation)
          return { dispatched: false, reason: "EXECUTION_LOST" }
        },
      },
    })
    const lost = await ai
      .generateText({
        model: MODEL,
        messages: [{ role: "user", content: "hi" }],
        spending: { ...spendingFor("ws_a"), executionGeneration: 7 },
      })
      .then(
        () => null,
        (error: unknown) => error
      )
    expect({
      lost: lost instanceof SpendingExecutionLostError && lost.attemptId,
      calls: kinds(calls),
      generations,
    }).toEqual({ lost: "att_1", calls: ["routeFor", "reserve", "dispatch"], generations: [7] })
  })

  it("derives the stage from the purpose and ignores a caller-forged stage", async () => {
    const calls: GateCall[] = []
    const ai = guardedAI(calls, () => jsonResponse(openRouterBody("ok")))
    const forged = { ...spendingFor("ws_a"), stage: "embedding" } as SpendingRequest
    await ai.generateText({ model: MODEL, messages: [{ role: "user", content: "hi" }], spending: forged })
    const reserve = calls.find((call) => call.kind === "reserve") as Extract<GateCall, { kind: "reserve" }>
    expect({ purpose: reserve.request.purpose, stage: reserve.request.stage }).toEqual({
      purpose: "assistant_turn",
      stage: "agent",
    })
  })

  it("gives distinct operations and steps distinct idempotency keys and a repeat the same one", async () => {
    const calls: GateCall[] = []
    const ai = guardedAI(calls, () => jsonResponse(openRouterBody("ok")))
    const messages = [{ role: "user" as const, content: "hi" }]
    const requests: SpendingRequest[] = [
      spendingFor("ws_a"),
      { ...spendingFor("ws_a"), requestKey: "step_2" },
      { ...spendingFor("ws_a"), operationId: "op_2" },
      // Would collide with op_1 + "step_1" under naive concatenation.
      { ...spendingFor("ws_a"), operationId: "op_1:req:step", requestKey: "_1" },
      spendingFor("ws_a"),
    ]
    for (const spending of requests) await ai.generateText({ model: MODEL, messages, spending })
    const keys = calls
      .filter((call): call is Extract<GateCall, { kind: "reserve" }> => call.kind === "reserve")
      .map((call) => call.request.idempotencyKey)
    expect(keys).toEqual([
      "op:4:op_1:req:step_1",
      "op:4:op_1:req:step_2",
      "op:4:op_2:req:step_1",
      "op:13:op_1:req:step:req:_1",
      "op:4:op_1:req:step_1",
    ])
  })

  it("denies before touching the gate when funding context, model or route is missing", async () => {
    const calls: GateCall[] = []
    const ai = guardedAI(calls, () => jsonResponse(openRouterBody("never")))
    const messages = [{ role: "user" as const, content: "hi" }]

    expect((await denial(ai.generateText({ model: MODEL, messages }))).code).toBe("MISSING_CONTEXT")
    expect(
      (
        await denial(
          ai.generateTextWithTools({ model: ai.getLanguageModel(MODEL), messages, spending: spendingFor("ws_a") })
        )
      ).code
    ).toBe("UNSUPPORTED_OPERATION")
    expect(
      (await denial(ai.generateText({ model: "anthropic:claude-sonnet-5", messages, spending: spendingFor("ws_a") })))
        .code
    ).toBe("UNKNOWN_ROUTE")
    expect(calls).toEqual([])

    const unknownRoute = await denial(
      ai.generateText({ model: "openrouter:anthropic/claude-sonnet-5", messages, spending: spendingFor("ws_a") })
    )
    expect(unknownRoute.code).toBe("UNKNOWN_ROUTE")
    expect(kinds(calls)).toEqual(["routeFor"])
  })

  it("refuses a partially bound funding context without consulting the gate", async () => {
    const calls: GateCall[] = []
    const ai = guardedAI(calls, () => jsonResponse(openRouterBody("never")))
    const messages = [{ role: "user" as const, content: "hi" }]
    const cases: Array<[Record<string, unknown>, string[]]> = [
      [{ userId: "" }, ["userId"]],
      [{ workspaceId: undefined, operationId: "" }, ["workspaceId", "operationId"]],
      [{ purpose: "cheap_infrastructure" }, ["purpose"]],
      [{ purpose: "toString" }, ["purpose"]],
      [{ requestKey: "" }, ["requestKey"]],
      [{ requestKey: undefined }, ["requestKey"]],
      [{ sessionId: "" }, ["sessionId"]],
      [{ sessionId: null }, ["sessionId", "executionGeneration"]],
      [{ sessionId: null, executionGeneration: null }, ["sessionId"]],
      [{ executionGeneration: null }, ["executionGeneration"]],
      [{ executionGeneration: undefined }, ["executionGeneration"]],
      [{ executionGeneration: -1 }, ["executionGeneration"]],
      [{ executionGeneration: 1.5 }, ["executionGeneration"]],
    ]
    for (const [override, fields] of cases) {
      const spending = { ...spendingFor("ws_a"), ...override } as SpendingRequest
      const error = await denial(ai.generateText({ model: MODEL, messages, spending }))
      expect({ code: error.code, fields: error.details.fields }).toEqual({ code: "MISSING_CONTEXT", fields })
    }
    expect(calls).toEqual([])
  })

  it("settles against the context bound at call time even if the caller mutates it afterwards", async () => {
    const calls: GateCall[] = []
    let release!: () => void
    const ai = guardedAI(
      calls,
      () => new Promise<Response>((resolve) => (release = () => resolve(jsonResponse(openRouterBody("ok")))))
    )
    const spending = spendingFor("ws_a")
    const pending = ai.generateText({ model: MODEL, messages: [{ role: "user", content: "hi" }], spending })
    while (!release) await new Promise((resolve) => setTimeout(resolve, 1))
    spending.workspaceId = "ws_other"
    release()
    await pending
    const settle = calls.find((c): c is Extract<GateCall, { kind: "settle" }> => c.kind === "settle")!
    expect(settle.params.workspaceId).toBe("ws_a")
  })

  it("keeps the funded identity, key, model and bound when the caller and the route profile change mid-call", async () => {
    const calls: GateCall[] = []
    const profile = { ...LUNA_OPENAI }
    const ai = guardedAI(calls, () => jsonResponse(openRouterBody("ok")), {
      routeFor: () => profile,
      reserve: () => {
        Object.assign(profile, {
          model: "openai/gpt-5.6-mini",
          providerSlug: "cheap",
          promptUsdPerToken: "0.00000001",
          completionUsdPerToken: "0.00000001",
          requestUsd: "5",
        })
        return { allowed: true, created: true, attempt: { id: "att_1", state: "reserved" } }
      },
    })
    const spending = spendingFor("ws_a")
    const pending = ai.generateText({ model: MODEL, messages: [{ role: "user", content: "hi" }], spending })
    Object.assign(spending, { userId: "usr_forged", operationId: "op_forged", requestKey: "step_forged" })
    await pending
    const reserve = calls.find((c): c is Extract<GateCall, { kind: "reserve" }> => c.kind === "reserve")!
    const wire = calls.find((c): c is Extract<GateCall, { kind: "fetch" }> => c.kind === "fetch")!.body
    expect({
      kinds: kinds(calls),
      key: reserve.request.idempotencyKey,
      sponsor: reserve.request.sponsorUserId,
      model: reserve.request.model,
      route: reserve.request.providerRoute,
      bound: reserve.request.maxCostUsd,
      wireModel: wire.model,
      wireProvider: wire.provider,
    }).toEqual({
      kinds: ["routeFor", "reserve", "dispatch", "fetch", "settle"],
      key: "op:4:op_1:req:step_1",
      sponsor: "usr_1",
      model: LUNA_OPENAI.model,
      route: "openai",
      bound: "0.6914",
      wireModel: LUNA_OPENAI.model,
      wireProvider: {
        order: ["openai"],
        allow_fallbacks: false,
        require_parameters: true,
        max_price: { prompt: "0.5", completion: "1.8" },
      },
    })
  })

  it("does not reserve for a request already aborted", async () => {
    const calls: GateCall[] = []
    const ai = guardedAI(calls, () => jsonResponse(openRouterBody("never")))
    const controller = new AbortController()
    controller.abort(new Error("turn cancelled"))
    await expect(
      ai.generateText({
        model: MODEL,
        messages: [{ role: "user", content: "hi" }],
        spending: spendingFor("ws_a"),
        abortSignal: controller.signal,
      })
    ).rejects.toThrow()
    expect(kinds(calls).filter((kind) => kind !== "routeFor")).toEqual([])
  })

  it("denies non-text content before reserve", async () => {
    const calls: GateCall[] = []
    const ai = guardedAI(calls, () => jsonResponse(openRouterBody("never")))
    const error = await denial(
      ai.generateText({
        model: MODEL,
        messages: [{ role: "user", content: [{ type: "image", image: "data:image/png;base64,AAAA" }] }],
        spending: spendingFor("ws_a"),
      })
    )
    expect({ code: error.code, field: error.details.field }).toEqual({
      code: "REQUEST_NOT_BOUNDED",
      field: "messages[0].content[0]",
    })
    expect(kinds(calls)).toEqual(["routeFor"])
  })

  it("denies a completion cap above the endpoint maximum before reserve", async () => {
    const calls: GateCall[] = []
    const ai = guardedAI(calls, () => jsonResponse(openRouterBody("never")))
    const error = await denial(
      ai.generateText({
        model: MODEL,
        messages: [{ role: "user", content: "hi" }],
        maxTokens: 200_000,
        spending: spendingFor("ws_a"),
      })
    )
    expect({ code: error.code, field: error.details.field }).toEqual({
      code: "REQUEST_NOT_BOUNDED",
      field: "max_tokens",
    })
    expect(kinds(calls)).toEqual(["routeFor"])
  })

  it("fails closed for object generation and embeddings in an enforced workspace", async () => {
    const calls: GateCall[] = []
    const ai = guardedAI(calls, () => jsonResponse(openRouterBody("never")))
    const messages = [{ role: "user" as const, content: "hi" }]
    const context = { workspaceId: "ws_a" }
    expect(
      (
        await denial(
          ai.generateObject({
            model: MODEL,
            schema: z.object({ a: z.string() }),
            messages,
            context,
          })
        )
      ).code
    ).toBe("UNSUPPORTED_OPERATION")
    expect(
      (await denial(ai.embed({ model: "openrouter:openai/text-embedding-3-small", value: "x", context }))).code
    ).toBe("UNSUPPORTED_OPERATION")
    expect(
      (await denial(ai.embedMany({ model: "openrouter:openai/text-embedding-3-small", values: ["x"], context }))).code
    ).toBe("UNSUPPORTED_OPERATION")
    expect(calls).toEqual([])
  })

  it("seals models handed out directly so raw SDK use cannot bypass the gate", async () => {
    const calls: GateCall[] = []
    const ai = guardedAI(calls, () => jsonResponse(openRouterBody("never")))
    const error = await denial(rawGenerateText({ model: ai.getLanguageModel(MODEL), prompt: "hi", maxRetries: 0 }))
    expect(error.code).toBe("MISSING_CONTEXT")
    expect(calls).toEqual([])
  })

  it("holds the commitment on a 500 and never retries", async () => {
    const calls: GateCall[] = []
    const ai = guardedAI(calls, () => jsonResponse({ error: { message: "upstream down", code: 500 } }, 500))
    const error = await unknownOutcome(
      ai.generateText({ model: MODEL, messages: [{ role: "user", content: "hi" }], spending: spendingFor("ws_a") })
    )
    expect({ attempts: error.attempts, cause: String((error.cause as Error).message) }).toEqual({
      attempts: [{ attemptId: "att_1", status: "held", reason: "cost_unavailable", providerRequestSent: true }],
      cause: expect.stringMatching(/upstream down/),
    })
    expect(kinds(calls)).toEqual(["routeFor", "reserve", "dispatch", "fetch", "markUnknown"])
  })

  it("holds the commitment when the network fails after dispatch and rethrows the original error", async () => {
    const calls: GateCall[] = []
    const failure = new TypeError("fetch failed")
    const ai = guardedAI(calls, () => {
      throw failure
    })
    const error = await unknownOutcome(
      ai.generateText({ model: MODEL, messages: [{ role: "user", content: "hi" }], spending: spendingFor("ws_a") })
    )
    expect({ attempts: error.attempts, cause: error.cause }).toEqual({
      attempts: [{ attemptId: "att_1", status: "held", reason: "provider_request_failed", providerRequestSent: true }],
      cause: failure,
    })
    expect(kinds(calls)).toEqual(["routeFor", "reserve", "dispatch", "fetch", "markUnknown"])
  })

  it("marks the attempt unknown when a successful response carries no cost", async () => {
    const calls: GateCall[] = []
    const ai = guardedAI(calls, () => jsonResponse(openRouterBody("ok", null)))
    const result = await ai.generateText({
      model: MODEL,
      messages: [{ role: "user", content: "hi" }],
      spending: spendingFor("ws_a"),
    })
    expect(result.spendingAttempts).toEqual([
      { attemptId: "att_1", status: "held", reason: "cost_unavailable", providerRequestSent: true },
    ])
    expect(result.value).toBe("ok")
    expect(kinds(calls)).toEqual(["routeFor", "reserve", "dispatch", "fetch", "markUnknown"])
  })

  it("settles a 200 whose body the SDK rejects, before the SDK throws", async () => {
    const calls: GateCall[] = []
    const ai = guardedAI(calls, () =>
      jsonResponse({
        id: "gen-err",
        error: { message: "moderation", code: 403 },
        usage: { prompt_tokens: 3, cost: 0.000001 },
      })
    )
    await expect(
      ai.generateText({ model: MODEL, messages: [{ role: "user", content: "hi" }], spending: spendingFor("ws_a") })
    ).rejects.toMatchObject({ code: "RESULT_UNAVAILABLE", cause: { message: expect.stringContaining("moderation") } })
    expect(kinds(calls)).toEqual(["routeFor", "reserve", "dispatch", "fetch", "settle"])
    expect((calls[4] as Extract<GateCall, { kind: "settle" }>).params).toEqual({
      workspaceId: "ws_a",
      attemptId: "att_1",
      actualCostUsd: "0.000001",
      receipt: { providerRequestId: "gen-err", usage: { prompt_tokens: 3 } },
    })

    const malformed: GateCall[] = []
    const ai2 = guardedAI(malformed, () => jsonResponse({ ...openRouterBody("x", { cost: 0.5 }), choices: [] }))
    await expect(
      ai2.generateText({ model: MODEL, messages: [{ role: "user", content: "hi" }], spending: spendingFor("ws_a") })
    ).rejects.toThrow()
    expect(kinds(malformed)).toEqual(["routeFor", "reserve", "dispatch", "fetch", "settle"])
  })

  it("passes a charge above the bound through untouched", async () => {
    const calls: GateCall[] = []
    const ai = guardedAI(calls, () => jsonResponse(openRouterBody("ok", { cost: 1.2345678912 })))
    await ai.generateText({
      model: MODEL,
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 8192,
      spending: spendingFor("ws_a"),
    })
    expect((calls[4] as Extract<GateCall, { kind: "settle" }>).params.actualCostUsd).toBe("1.2345679")
  })

  it("holds the commitment when the response body cannot be read", async () => {
    const calls: GateCall[] = []
    const ai = guardedAI(
      calls,
      () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              controller.error(new Error("connection reset mid-body"))
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
    )
    const error = await unknownOutcome(
      ai.generateText({ model: MODEL, messages: [{ role: "user", content: "hi" }], spending: spendingFor("ws_a") })
    )
    expect(error.attempts).toEqual([
      { attemptId: "att_1", status: "held", reason: "response_unreadable", providerRequestSent: true },
    ])
    expect(kinds(calls)).toEqual(["routeFor", "reserve", "dispatch", "fetch", "markUnknown"])
  })

  it("still surfaces the dispatch denial when releasing the reservation fails", async () => {
    const calls: GateCall[] = []
    const gate = fakeGate(calls, { dispatch: () => ({ dispatched: false, reason: "DISABLED" }) })
    gate.release = async (workspaceId, attemptId) => {
      calls.push({ kind: "release", workspaceId, attemptId })
      throw new Error("ledger unavailable")
    }
    const ai = createAI({
      openrouter: { apiKey: "test-key", fetch: fakeFetch(calls, () => jsonResponse(openRouterBody("never"))) },
      spendingGate: gate,
    })
    const error = await denial(
      ai.generateText({ model: MODEL, messages: [{ role: "user", content: "hi" }], spending: spendingFor("ws_a") })
    )
    expect(error.code).toBe("DISABLED")
    expect(kinds(calls)).toEqual(["routeFor", "reserve", "dispatch", "release"])
  })

  it("marks the attempt unknown when the reported charge cannot be stored", async () => {
    const calls: GateCall[] = []
    const ai = guardedAI(calls, () => jsonResponse(openRouterBody("ok", { cost: 1e13 })))
    await ai.generateText({ model: MODEL, messages: [{ role: "user", content: "hi" }], spending: spendingFor("ws_a") })
    expect(kinds(calls)).toEqual(["routeFor", "reserve", "dispatch", "fetch", "markUnknown"])
  })

  it("keeps the commitment when settlement fails and still returns the answer once", async () => {
    const calls: GateCall[] = []
    const ai = guardedAI(calls, () => jsonResponse(openRouterBody("ok")), {
      settle: async () => {
        throw new Error("ledger unavailable")
      },
    })
    const result = await ai.generateText({
      model: MODEL,
      messages: [{ role: "user", content: "hi" }],
      spending: spendingFor("ws_a"),
    })
    expect({ value: result.value, spendingAttempts: result.spendingAttempts }).toEqual({
      value: "ok",
      spendingAttempts: [
        { attemptId: "att_1", status: "held", reason: "settlement_failed", providerRequestSent: true },
      ],
    })
    expect(kinds(calls)).toEqual(["routeFor", "reserve", "dispatch", "fetch", "settle", "markUnknown"])
  })

  it("holds an attempt whose dispatch outcome is lost, without releasing or sending", async () => {
    const calls: GateCall[] = []
    const ledgerFailure = new Error("connection terminated")
    const gate = fakeGate(calls)
    gate.dispatch = async (workspaceId, attemptId) => {
      calls.push({ kind: "dispatch", workspaceId, attemptId })
      throw ledgerFailure
    }
    const ai = createAI({
      openrouter: { apiKey: "test-key", fetch: fakeFetch(calls, () => jsonResponse(openRouterBody("never"))) },
      spendingGate: gate,
    })
    const error = await unknownOutcome(
      ai.generateText({ model: MODEL, messages: [{ role: "user", content: "hi" }], spending: spendingFor("ws_a") })
    )
    expect(error.attempts).toEqual([
      { attemptId: "att_1", status: "held", reason: "dispatch_failed", providerRequestSent: false },
    ])
    expect(kinds(calls)).toEqual(["routeFor", "reserve", "dispatch", "markUnknown"])
  })

  it("reports a successful paid answer as held when marking it unknown also fails", async () => {
    const calls: GateCall[] = []
    const gate = fakeGate(calls, {
      settle: async () => {
        throw new Error("ledger unavailable")
      },
    })
    gate.markUnknown = async (workspaceId, attemptId) => {
      calls.push({ kind: "markUnknown", workspaceId, attemptId })
      throw new Error("ledger still unavailable")
    }
    const ai = createAI({
      openrouter: { apiKey: "test-key", fetch: fakeFetch(calls, () => jsonResponse(openRouterBody("ok"))) },
      spendingGate: gate,
    })
    const result = await ai.generateText({
      model: MODEL,
      messages: [{ role: "user", content: "hi" }],
      spending: spendingFor("ws_a"),
    })
    expect({ value: result.value, spendingAttempts: result.spendingAttempts }).toEqual({
      value: "ok",
      spendingAttempts: [
        { attemptId: "att_1", status: "held", reason: "settlement_failed", providerRequestSent: true },
      ],
    })
    expect(kinds(calls)).toEqual(["routeFor", "reserve", "dispatch", "fetch", "settle", "markUnknown"])
  })

  it("settles the exact raw cost literal through the installed SDK", async () => {
    const calls: GateCall[] = []
    const raw = JSON.stringify(openRouterBody("ok", { cost: 1 })).replace(
      '"cost":1',
      '"cost":0.0000000100000000000000001'
    )
    const ai = guardedAI(
      calls,
      () => new Response(raw, { status: 200, headers: { "content-type": "application/json" } })
    )
    const result = await ai.generateText({
      model: MODEL,
      messages: [{ role: "user", content: "hi" }],
      spending: spendingFor("ws_a"),
    })
    expect(result.spendingAttempts).toEqual([{ attemptId: "att_1", status: "settled" }])
    expect((calls[4] as Extract<GateCall, { kind: "settle" }>).params.actualCostUsd).toBe("0.00000002")
  })

  it("never degrades the requested model through the legacy budget policy under a gate", async () => {
    const checked: string[] = []
    const budgetEnforcer: BudgetEnforcer = {
      async checkBudget(_workspaceId, model) {
        checked.push(model ?? "")
        return {
          allowed: true,
          reason: "soft_limit",
          currentUsageUsd: 9,
          budgetUsd: 10,
          percentUsed: 90,
          recommendedModel: "openrouter:openai/gpt-5.6-mini",
        }
      },
    }
    const request = {
      model: MODEL,
      messages: [{ role: "user" as const, content: "hi" }],
      context: { workspaceId: "ws_a" },
      spending: spendingFor("ws_a"),
    }

    const legacyCalls: GateCall[] = []
    await createAI({
      openrouter: { apiKey: "test-key", fetch: fakeFetch(legacyCalls, () => jsonResponse(openRouterBody("ok"))) },
      budgetEnforcer,
    }).generateText(request)

    const calls: GateCall[] = []
    await createAI({
      openrouter: { apiKey: "test-key", fetch: fakeFetch(calls, () => jsonResponse(openRouterBody("ok"))) },
      spendingGate: fakeGate(calls),
      budgetEnforcer,
    }).generateText(request)

    expect({
      checked,
      legacyWireModel: (legacyCalls[0] as Extract<GateCall, { kind: "fetch" }>).body.model,
      gatedRoute: (calls[0] as Extract<GateCall, { kind: "routeFor" }>).modelId,
      gatedWireModel: (calls[3] as Extract<GateCall, { kind: "fetch" }>).body.model,
    }).toEqual({
      checked: [MODEL],
      legacyWireModel: "openai/gpt-5.6-mini",
      gatedRoute: LUNA_OPENAI.model,
      gatedWireModel: LUNA_OPENAI.model,
    })
  })

  it("refuses tool calls on a model handle it cannot rebuild without changing semantics", async () => {
    const calls: GateCall[] = []
    const ai = guardedAI(calls, () => jsonResponse(openRouterBody("never")))
    const messages = [{ role: "user" as const, content: "hi" }]
    const customRoute = createOpenRouter({ apiKey: "test-key" }).chat(LUNA_OPENAI.model, {
      usage: { include: true },
      provider: { order: ["azure"], data_collection: "deny" },
    })
    const foreign = await denial(
      ai.generateTextWithTools({ model: customRoute, modelString: MODEL, messages, spending: spendingFor("ws_a") })
    )
    const otherInstance = createAI({ openrouter: { apiKey: "test-key" } }).getLanguageModel(MODEL)
    const otherAI = await denial(
      ai.generateTextWithTools({ model: otherInstance, modelString: MODEL, messages, spending: spendingFor("ws_a") })
    )
    const mismatched = await denial(
      ai.generateTextWithTools({
        model: ai.getLanguageModel("openrouter:openai/gpt-5.6"),
        modelString: MODEL,
        messages,
        spending: spendingFor("ws_a"),
      })
    )
    expect([foreign.details.reason, otherAI.details.reason, mismatched.details.reason]).toEqual([
      "model handle not issued by this AI",
      "model handle not issued by this AI",
      "modelString mismatch",
    ])
    expect([foreign.code, otherAI.code, mismatched.code]).toEqual([
      "UNSUPPORTED_OPERATION",
      "UNSUPPORTED_OPERATION",
      "UNSUPPORTED_OPERATION",
    ])
    expect(calls).toEqual([])
  })

  it("keeps concurrent attempts bound to their own workspace and user", async () => {
    const calls: GateCall[] = []
    const gates = new Map<string, () => void>()
    const ai = guardedAI(calls, (body) => {
      const marker = String((body.messages as Array<{ content: string }>)[0]?.content)
      return new Promise<Response>((resolve) => {
        gates.set(marker, () =>
          resolve(jsonResponse(openRouterBody(`reply:${marker}`, { cost: marker === "ws_a" ? 0.01 : 0.02 })))
        )
      })
    })
    const a = ai.generateText({
      model: MODEL,
      messages: [{ role: "user", content: "ws_a" }],
      spending: spendingFor("ws_a", "usr_a"),
    })
    const b = ai.generateText({
      model: MODEL,
      messages: [{ role: "user", content: "ws_b" }],
      spending: spendingFor("ws_b", "usr_b"),
    })
    while (gates.size < 2) await new Promise((resolve) => setTimeout(resolve, 1))
    gates.get("ws_b")!()
    gates.get("ws_a")!()
    const [ra, rb] = await Promise.all([a, b])
    expect([ra.value, rb.value]).toEqual(["reply:ws_a", "reply:ws_b"])

    const reserves = calls.filter((c): c is Extract<GateCall, { kind: "reserve" }> => c.kind === "reserve")
    const settles = calls.filter((c): c is Extract<GateCall, { kind: "settle" }> => c.kind === "settle")
    const attemptOf = (workspaceId: string) =>
      calls.find(
        (c): c is Extract<GateCall, { kind: "dispatch" }> => c.kind === "dispatch" && c.workspaceId === workspaceId
      )!.attemptId
    expect(reserves.map((r) => [r.request.workspaceId, r.request.sponsorUserId]).sort()).toEqual([
      ["ws_a", "usr_a"],
      ["ws_b", "usr_b"],
    ])
    expect(settles.map((s) => [s.params.workspaceId, s.params.attemptId, s.params.actualCostUsd])).toEqual([
      ["ws_b", attemptOf("ws_b"), "0.02"],
      ["ws_a", attemptOf("ws_a"), "0.01"],
    ])
    // The ledger key is unique per workspace, so the same logical step in two workspaces never collides.
    expect(reserves.map((r) => `${r.request.workspaceId} ${r.request.idempotencyKey}`).sort()).toEqual([
      "ws_a op:4:op_1:req:step_1",
      "ws_b op:4:op_1:req:step_1",
    ])
  })

  it("never hands prompt or completion text to the gate", async () => {
    const calls: GateCall[] = []
    const ai = guardedAI(calls, () => jsonResponse(openRouterBody("SECRET-REPLY")))
    await ai.generateText({
      model: MODEL,
      messages: [{ role: "user", content: "SECRET-PROMPT" }],
      spending: spendingFor("ws_a"),
    })
    const gateCalls = JSON.stringify(calls.filter((c) => c.kind !== "fetch"))
    expect(gateCalls).not.toContain("SECRET")
  })

  it("leaves an ungated instance unmetered with the legacy transport", async () => {
    const calls: GateCall[] = []
    const ai = createAI({
      openrouter: { apiKey: "test-key", fetch: fakeFetch(calls, () => jsonResponse(openRouterBody("ok"))) },
    })
    const result = await ai.generateText({ model: MODEL, messages: [{ role: "user", content: "hi" }] })
    expect(result.value).toBe("ok")
    const wire = (calls[0] as Extract<GateCall, { kind: "fetch" }>).body
    expect({ provider: wire.provider, max_tokens: wire.max_tokens }).toEqual({
      provider: undefined,
      max_tokens: undefined,
    })
    expect(result.spendingAttempts).toBeUndefined()
  })

  it("keeps a caller's custom model handle on the ungated tools path", async () => {
    const calls: GateCall[] = []
    const ai = createAI({ openrouter: { apiKey: "test-key" } })
    const custom = createOpenRouter({
      apiKey: "test-key",
      fetch: fakeFetch(calls, () => jsonResponse(openRouterBody("ok"))) as typeof fetch,
    }).chat(LUNA_OPENAI.model, { usage: { include: true }, provider: { order: ["azure"], data_collection: "deny" } })
    const result = await ai.generateTextWithTools({ model: custom, messages: [{ role: "user", content: "hi" }] })
    expect(result.text).toBe("ok")
    expect((calls[0] as Extract<GateCall, { kind: "fetch" }>).body.provider).toEqual({
      order: ["azure"],
      data_collection: "deny",
    })
  })
})

describe("one gated AI across workspace policy modes", () => {
  const UNPROTECTED: SpendingPolicyMode = { mode: "unprotected" }
  const ENFORCED: SpendingPolicyMode = { mode: "protected", denial: null }
  const EMBEDDING_MODEL = "openrouter:openai/text-embedding-3-small"
  const messages = [{ role: "user" as const, content: "hi" }]

  interface WireRequest {
    path: string
    body: Record<string, unknown>
    redirect: RequestRedirect | undefined
  }

  type ProviderHandler = (request: WireRequest) => Response

  function embeddingBody(count: number) {
    return {
      object: "list",
      model: "openai/text-embedding-3-small",
      data: Array.from({ length: count }, (_, index) => ({ object: "embedding", embedding: [0.1, 0.2], index })),
      usage: { prompt_tokens: 2, total_tokens: 2, cost: 0.000001 },
    }
  }

  const provider: ProviderHandler = (request) =>
    request.path.endsWith("/embeddings")
      ? jsonResponse(embeddingBody((request.body.input as unknown[]).length))
      : jsonResponse(openRouterBody('{"a":"x"}'))

  function modeAI(
    policy: (workspaceId: string) => SpendingPolicyMode | Promise<SpendingPolicyMode>,
    options: {
      handler?: ProviderHandler
      budgetEnforcer?: BudgetEnforcer
      costRecorder?: CostRecorder
      accessLogSink?: AccessLogSink
    } = {}
  ) {
    const calls: GateCall[] = []
    const reads: string[] = []
    const wire: WireRequest[] = []
    const ai = createAI({
      openrouter: {
        apiKey: "test-key",
        fetch: async (input, init) => {
          const request = {
            path: new URL(String(input)).pathname,
            body: JSON.parse(String(init?.body)) as Record<string, unknown>,
            redirect: init?.redirect,
          }
          wire.push(request)
          return (options.handler ?? provider)(request)
        },
      },
      spendingGate: fakeGate(calls, {
        policyMode: (workspaceId) => {
          reads.push(workspaceId)
          return policy(workspaceId)
        },
      }),
      budgetEnforcer: options.budgetEnforcer,
      costRecorder: options.costRecorder,
      accessLogSink: options.accessLogSink,
    })
    return { ai, calls, reads, wire }
  }

  function paidMethods(ai: AI, context: { workspaceId: string } = { workspaceId: "ws_a" }) {
    return {
      generateText: () => ai.generateText({ model: MODEL, messages, context }),
      generateTextWithTools: () =>
        ai.generateTextWithTools({ model: ai.getLanguageModel(MODEL), modelString: MODEL, messages, context }),
      generateObject: () => ai.generateObject({ model: MODEL, schema: z.object({ a: z.string() }), messages, context }),
      embed: () => ai.embed({ model: EMBEDDING_MODEL, value: "x", context }),
      embedMany: () => ai.embedMany({ model: EMBEDDING_MODEL, values: ["x", "y"], context }),
    }
  }

  function overloaded(): Response {
    return new Response(JSON.stringify({ error: { message: "overloaded", code: 503 } }), {
      status: 503,
      headers: { "content-type": "application/json", "retry-after-ms": "1" },
    })
  }

  it("should run all five paid methods unmetered through a rechecked fetch when the workspace is explicitly unprotected", async () => {
    const { ai, calls, reads, wire } = modeAI(() => UNPROTECTED)
    const results: Record<string, unknown> = {}
    for (const [name, run] of Object.entries(paidMethods(ai))) {
      const result = (await run()) as { spendingAttempts?: unknown }
      results[name] = result.spendingAttempts
    }

    const chat = {
      path: "/api/v1/chat/completions",
      model: LUNA_OPENAI.model,
      provider: undefined,
      redirect: "error" as const,
    }
    const embeddings = {
      path: "/api/v1/embeddings",
      model: "openai/text-embedding-3-small",
      provider: undefined,
      redirect: "error" as const,
    }
    expect({
      results,
      gateLedgerCalls: calls,
      reads,
      wire: wire.map(({ path, body, redirect }) => ({ path, model: body.model, provider: body.provider, redirect })),
    }).toEqual({
      results: {
        generateText: undefined,
        generateTextWithTools: undefined,
        generateObject: undefined,
        embed: undefined,
        embedMany: undefined,
      },
      gateLedgerCalls: [],
      // One mode decision per call plus one recheck per physical request.
      reads: Array(10).fill("ws_a"),
      wire: [chat, chat, chat, embeddings, embeddings],
    })
  })

  it("should deny every paid method with zero egress when the policy is missing, disabled, emergency or unrecognized", async () => {
    const cases: Array<[SpendingPolicyMode, string]> = [
      [{ mode: "protected", denial: "NOT_PROVISIONED" }, "NOT_PROVISIONED"],
      [{ mode: "protected", denial: "DISABLED" }, "DISABLED"],
      [{ mode: "protected", denial: "EMERGENCY" }, "EMERGENCY"],
      [{ mode: "legacy" } as unknown as SpendingPolicyMode, "NOT_PROVISIONED"],
      [{ mode: "protected", denial: "LIMIT_EXCEEDED" } as unknown as SpendingPolicyMode, "NOT_PROVISIONED"],
    ]
    for (const [policy, expected] of cases) {
      const { ai, calls, wire } = modeAI(() => policy)
      const codes: Record<string, string> = {}
      for (const [name, run] of Object.entries(paidMethods(ai))) codes[name] = (await denial(run())).code
      expect({ policy, codes, calls, wire }).toEqual({
        policy,
        codes: {
          generateText: expected,
          generateTextWithTools: expected,
          generateObject: expected,
          embed: expected,
          embedMany: expected,
        },
        calls: [],
        wire: [],
      })
    }
  })

  it("should apply legacy budget degradation only to an explicitly unprotected workspace", async () => {
    const checked: string[] = []
    const budgetEnforcer: BudgetEnforcer = {
      async checkBudget(_workspaceId, model) {
        checked.push(model ?? "")
        return {
          allowed: true,
          reason: "soft_limit",
          currentUsageUsd: 9,
          budgetUsd: 10,
          percentUsed: 90,
          recommendedModel: "openrouter:openai/gpt-5.6-mini",
        }
      },
    }
    const request = { model: MODEL, messages, context: { workspaceId: "ws_a" }, spending: spendingFor("ws_a") }

    const legacy = modeAI(() => UNPROTECTED, { budgetEnforcer })
    await legacy.ai.generateText(request)
    const legacyChecked = checked.splice(0)

    const enforced = modeAI(() => ENFORCED, { budgetEnforcer })
    await enforced.ai.generateText(request)

    expect({
      legacyChecked,
      legacyWireModel: legacy.wire[0]?.body.model,
      legacyLedger: legacy.calls,
      enforcedChecked: checked,
      enforcedWireModel: enforced.wire[0]?.body.model,
      enforcedLedger: kinds(enforced.calls),
    }).toEqual({
      legacyChecked: [MODEL],
      legacyWireModel: "openai/gpt-5.6-mini",
      legacyLedger: [],
      enforcedChecked: [],
      enforcedWireModel: LUNA_OPENAI.model,
      enforcedLedger: ["routeFor", "reserve", "dispatch", "settle"],
    })
  })

  it("should keep SDK retries on the legacy path but send no retry once the workspace stops being unprotected", async () => {
    for (const method of ["generateText", "generateTextWithTools", "embedMany"] as const) {
      const steady = modeAI(() => UNPROTECTED, { handler: overloaded })
      await expect(paidMethods(steady.ai)[method]()).rejects.toThrow()

      let policy: SpendingPolicyMode = UNPROTECTED
      const flipped = modeAI(() => policy, {
        handler: () => {
          policy = ENFORCED
          return overloaded()
        },
      })
      const error = await denial(paidMethods(flipped.ai)[method]())

      expect({ method, steadyWire: steady.wire.length, code: error.code, flippedWire: flipped.wire.length }).toEqual({
        method,
        steadyWire: 3,
        code: "POLICY_CHANGED",
        flippedWire: 1,
      })
      expect(flipped.calls).toEqual([])
    }
  })

  it("should refuse mismatched or missing workspace identity before any policy read", async () => {
    const { ai, reads, wire } = modeAI(() => UNPROTECTED)
    const mismatch = await denial(
      ai.generateText({ model: MODEL, messages, context: { workspaceId: "ws_b" }, spending: spendingFor("ws_a") })
    )
    const missing = await denial(ai.embed({ model: EMBEDDING_MODEL, value: "x" }))
    expect({
      mismatch: { code: mismatch.code, reason: mismatch.details.reason },
      missing: { code: missing.code, fields: missing.details.fields },
      reads,
      wire,
    }).toEqual({
      mismatch: { code: "MISSING_CONTEXT", reason: "workspace mismatch" },
      missing: { code: "MISSING_CONTEXT", fields: ["workspaceId"] },
      reads: [],
      wire: [],
    })
  })

  it("should deny an unprotected call funded only by a spending request rather than skip the legacy budget and usage record", async () => {
    const budgetChecks: string[] = []
    const recorded: string[] = []
    const { ai, calls, reads, wire } = modeAI(() => UNPROTECTED, {
      budgetEnforcer: {
        checkBudget: async (workspaceId) => {
          budgetChecks.push(workspaceId)
          return { allowed: true, reason: "within_budget", currentUsageUsd: 0, budgetUsd: 10, percentUsed: 0 }
        },
      },
      costRecorder: { recordUsage: async ({ workspaceId }) => void recorded.push(workspaceId) },
    })
    const error = await denial(ai.generateText({ model: MODEL, messages, spending: spendingFor("ws_a") }))
    const tools = await denial(
      ai.generateTextWithTools({
        model: ai.getLanguageModel(MODEL),
        modelString: MODEL,
        messages,
        spending: spendingFor("ws_a"),
      })
    )
    await ai.generateText({ model: MODEL, messages, context: { workspaceId: "ws_a" }, spending: spendingFor("ws_a") })
    expect({
      denials: [error, tools].map((e) => ({ code: e.code, fields: e.details.fields })),
      reads,
      calls,
      wireCount: wire.length,
      budgetChecks,
      recorded,
    }).toEqual({
      denials: [
        { code: "MISSING_CONTEXT", fields: ["costContext"] },
        { code: "MISSING_CONTEXT", fields: ["costContext"] },
      ],
      reads: ["ws_a", "ws_a", "ws_a", "ws_a"],
      calls: [],
      wireCount: 1,
      budgetChecks: ["ws_a"],
      recorded: ["ws_a"],
    })
  })

  it("should never let a telemetry workspace fund an enforced call", async () => {
    const { ai, calls, reads, wire } = modeAI(() => ENFORCED)
    const error = await denial(
      ai.generateText({ model: MODEL, messages, context: { workspaceId: "ws_a", userId: "usr_1" } })
    )
    expect({ code: error.code, fields: error.details.fields, reads, calls, wire }).toEqual({
      code: "MISSING_CONTEXT",
      fields: ["context"],
      reads: ["ws_a"],
      calls: [],
      wire: [],
    })
  })

  it("should keep reading and recording the workspace captured at call time when the caller or a sink mutates its context", async () => {
    let releaseRead!: () => void
    const firstRead = new Promise<void>((resolve) => (releaseRead = resolve))
    const recorded: string[] = []
    const { ai, reads, wire } = modeAI(
      async () => {
        if (reads.length === 1) await firstRead
        return UNPROTECTED
      },
      {
        costRecorder: {
          async recordUsage({ workspaceId }) {
            recorded.push(workspaceId)
          },
        },
        accessLogSink: {
          record({ context }) {
            ;(context as { workspaceId: string }).workspaceId = "ws_sink"
          },
        },
      }
    )
    const context = { workspaceId: "ws_a" }
    const pending = ai.generateText({ model: MODEL, messages, context })
    context.workspaceId = "ws_b"
    releaseRead()
    await pending
    expect({ reads, recorded, wire: wire.length }).toEqual({ reads: ["ws_a", "ws_a"], recorded: ["ws_a"], wire: 1 })
  })

  it("should refuse a caller's custom model handle under a gate even when the workspace is unprotected", async () => {
    const { ai, reads, wire } = modeAI(() => UNPROTECTED)
    const customWire: unknown[] = []
    const custom = createOpenRouter({
      apiKey: "test-key",
      fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        customWire.push(init?.body)
        return jsonResponse(openRouterBody("never"))
      }) as typeof fetch,
    }).chat(LUNA_OPENAI.model, { usage: { include: true }, provider: { order: ["azure"], data_collection: "deny" } })
    const error = await denial(
      ai.generateTextWithTools({ model: custom, modelString: MODEL, messages, context: { workspaceId: "ws_a" } })
    )
    expect({ code: error.code, reason: error.details.reason, reads, wire, customWire }).toEqual({
      code: "UNSUPPORTED_OPERATION",
      reason: "model handle not issued by this AI",
      reads: [],
      wire: [],
      customWire: [],
    })
  })

  it("should keep directly issued model handles sealed when the workspace is unprotected", async () => {
    const { ai, reads, wire } = modeAI(() => UNPROTECTED)
    const text = await denial(rawGenerateText({ model: ai.getLanguageModel(MODEL), prompt: "hi" }))
    const embedding = await denial(rawEmbed({ model: ai.getEmbeddingModel(EMBEDDING_MODEL), value: "x" }))
    expect({ codes: [text.code, embedding.code], reads, wire }).toEqual({
      codes: ["MISSING_CONTEXT", "MISSING_CONTEXT"],
      reads: [],
      wire: [],
    })
  })
})

describe("createGuardedFetch at the physical boundary", () => {
  it("rejects a tampered final body before reserve and a foreign endpoint outright", async () => {
    const calls: GateCall[] = []
    const gate = fakeGate(calls)
    const quote = quoteAttempt(LUNA_OPENAI, 8192)
    const guarded = createGuardedFetch({
      functionId: "test-guarded-fetch",
      gate,
      context: spendingFor("ws_a"),
      profile: LUNA_OPENAI,
      quote,
      baseFetch: fakeFetch(calls, () => jsonResponse(openRouterBody("never"))),
      onOutcome: () => {},
    })
    const body = {
      model: LUNA_OPENAI.model,
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 8192,
      usage: { include: true },
      provider: providerRouting(LUNA_OPENAI),
      plugins: [{ id: "web" }],
    }
    const tampered = await denial(
      guarded(OPENROUTER_CHAT_COMPLETIONS_URL, { method: "POST", body: JSON.stringify(body) })
    )
    expect({ code: tampered.code, field: tampered.details.field }).toEqual({
      code: "REQUEST_NOT_BOUNDED",
      field: "plugins",
    })

    const model = createOpenRouter({ apiKey: "test-key", fetch: guarded as typeof fetch }).chat(LUNA_OPENAI.model, {
      usage: { include: true },
      provider: providerRouting(LUNA_OPENAI),
      maxTokens: 8192,
    })
    const widenings = [
      { plugins: [{ id: "web" }] },
      { provider: { ...providerRouting(LUNA_OPENAI), allow_fallbacks: true } },
      { extraBody: { service_tier: "priority" } },
      { models: ["openai/gpt-5.6"] },
    ]
    for (const openrouter of widenings) {
      const widened = await denial(
        rawGenerateText({ model, prompt: "hi", maxOutputTokens: 8192, maxRetries: 0, providerOptions: { openrouter } })
      )
      expect(widened.code).toBe("REQUEST_NOT_BOUNDED")
    }

    const foreign = await denial(
      guarded("https://openrouter.ai/api/v1/embeddings", { method: "POST", body: JSON.stringify({}) })
    )
    expect(foreign.code).toBe("UNSUPPORTED_OPERATION")
    expect(calls).toEqual([])
  })
})
