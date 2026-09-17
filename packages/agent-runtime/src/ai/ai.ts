/**
 * AI SDK Wrapper
 *
 * Provides a clean abstraction over the Vercel AI SDK with:
 * - No `experimental_` prefixes
 * - Automatic repair for generateObject
 * - Unified `{ value, response }` return type
 * - Extended model ID parsing (extracts modelProvider)
 * - Spend admission before every provider call
 */

import {
  generateText as aiGenerateText,
  generateObject as aiGenerateObject,
  embed as aiEmbed,
  embedMany as aiEmbedMany,
} from "ai"
import type { AISpendDenialReason } from "@threahq/types"
import type { Embedding, LanguageModel, EmbeddingModel, ModelMessage, Tool } from "ai"
import type { z } from "zod"
import { createOpenRouter } from "@openrouter/ai-sdk-provider"
import { stripMarkdownFences } from "./text-utils"
import { logger } from "../logger"

export interface ParsedModel {
  /** The provider (e.g., "openrouter", "anthropic") */
  provider: string
  /** The full model ID after the provider prefix (e.g., "anthropic/claude-haiku-4.5") */
  modelId: string
  /** The model's provider extracted from modelId path, or same as provider for direct APIs */
  modelProvider: string
  /** The model name without provider path (e.g., "claude-haiku-4.5") */
  modelName: string
}

/** Origin of the AI call - system operations vs user-initiated */
export type AIOrigin = "system" | "user"

/** Interface for cost service to record AI usage */
export interface CostRecorder {
  recordUsage(params: {
    workspaceId: string
    userId?: string
    sessionId?: string
    functionId: string
    model: string
    provider: string
    origin: AIOrigin
    usage: UsageWithCost
    /** Wall time of the provider call. Absent when the caller did not time it. */
    latencyMs?: number
    metadata?: Record<string, unknown>
  }): Promise<void>
}

/**
 * Sink for access-log `disclose` rows — content egress to a model provider is a
 * trust-boundary crossing (design §7.3). Injected by the backend; agent-runtime
 * never imports the backend, so the mapping to an audit row lives there. Fired
 * best-effort after each AI call; a throw or rejection is swallowed and never
 * fails the AI call.
 */
export interface AccessLogSink {
  record(event: {
    functionId: string
    provider: string
    modelId: string
    context?: CostContext
    metadata?: Record<string, unknown>
  }): void | Promise<void>
}

export interface AIConfig {
  openrouter?: { apiKey: string }
  defaults?: {
    repair?: RepairFunction
  }
  /** When provided, usage will be recorded after each AI call (requires context in options) */
  costRecorder?: CostRecorder
  /** When provided, every call carrying a context is admitted or denied before it reaches the provider */
  spendGate?: SpendGate
  /** When provided, a `disclose` access-log row is emitted for each AI call (design §7.3) */
  accessLogSink?: AccessLogSink
}

/**
 * Telemetry metadata values are scalar tags, plus an optional subject-ref array
 * threaded to the access-log disclose sink (design §7.3) so AI egress is linkable
 * by data subject — ids, never content.
 */
export type TelemetryMetadataValue = string | number | boolean | undefined | ReadonlyArray<{ type: string; id: string }>

export interface TelemetryConfig {
  functionId: string
  metadata?: Record<string, TelemetryMetadataValue>
}

/** Context for cost tracking - when provided, usage will be recorded */
export interface CostContext {
  workspaceId: string
  userId?: string
  sessionId?: string
  /** Origin of the AI call - defaults to 'system' if not specified */
  origin?: AIOrigin
}

export type SpendDecision = { allowed: true } | { allowed: false; reason: AISpendDenialReason }

export interface SpendAdmissionRequest {
  workspaceId: string
  userId?: string
  functionId: string
}

export interface SpendGate {
  admit(request: SpendAdmissionRequest): Promise<SpendDecision>
}

export class AISpendDeniedError extends Error {
  readonly workspaceId: string
  readonly userId: string | undefined
  readonly functionId: string
  readonly reason: AISpendDenialReason

  constructor(request: SpendAdmissionRequest, reason: AISpendDenialReason) {
    super(`AI call "${request.functionId}" denied for workspace ${request.workspaceId}: ${reason}`)
    this.name = "AISpendDeniedError"
    this.workspaceId = request.workspaceId
    this.userId = request.userId
    this.functionId = request.functionId
    this.reason = reason
  }
}

/** Message types matching Vercel AI SDK */
export type MessageRole = "system" | "user" | "assistant"

/**
 * Text content part for multi-modal messages.
 * Matches AI SDK's TextPart type.
 */
export interface TextContentPart {
  type: "text"
  text: string
}

/**
 * Image content part for multi-modal messages.
 * Matches AI SDK's ImagePart type.
 *
 * The image field accepts:
 * - Base64-encoded string
 * - Base64 data URL (e.g., "data:image/png;base64,...")
 * - HTTP(S) URL
 * - Uint8Array, Buffer, or ArrayBuffer
 */
export interface ImageContentPart {
  type: "image"
  /** Image data: base64 string, data URL, http(s) URL, or binary data */
  image: string | Uint8Array | Buffer | ArrayBuffer | URL
  /** Optional IANA media type (e.g., "image/png", "image/jpeg") */
  mimeType?: string
}

/** Content that can be either a simple string or an array of content parts */
export type MessageContent = string | (TextContentPart | ImageContentPart)[]

export interface Message {
  role: MessageRole
  content: MessageContent
}

export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh"

export interface GenerateTextOptions {
  model: string
  messages: Message[]
  maxTokens?: number
  temperature?: number
  reasoningEffort?: ReasoningEffort
  telemetry?: TelemetryConfig
  /** When provided, usage will be recorded to the database */
  context?: CostContext
  /** Abort signal for graceful cancellation / per-call timeouts */
  abortSignal?: AbortSignal
}

/**
 * Options for generateText with tool support.
 * Accepts a pre-resolved LanguageModel for use in agent loops that
 * resolve the model once and call generateText many times.
 */
export interface GenerateTextWithToolsOptions {
  model: LanguageModel
  /**
   * The original provider:model string for the resolved `model`.
   * Required alongside `context` so usage can be recorded with a parseable
   * model identifier (the resolved LanguageModel does not expose the
   * original provider prefix needed by the cost recorder).
   */
  modelString?: string
  system?: string
  /**
   * Per-turn system content kept out of the cached prefix. Only meaningful with
   * `cachePrefix`; without it the two halves are simply rejoined.
   */
  volatileSystem?: string
  messages: ModelMessage[]
  tools?: Record<string, Tool<any, any>>
  maxTokens?: number
  temperature?: number
  telemetry?: TelemetryConfig
  /** When provided with `modelString`, usage will be recorded to the database */
  context?: CostContext
  /** Abort signal for graceful cancellation / per-call timeouts */
  abortSignal?: AbortSignal
  /**
   * Place Anthropic prompt-cache breakpoints on this request. Caching is a
   * prefix match over `tools` → `system` → `messages`, so one breakpoint on the
   * system message also caches every tool definition ahead of it (~12k tokens
   * for the companion toolset) and a second on the newest message caches the
   * conversation an agent loop appends to each iteration.
   *
   * Opt-in because a cache write costs 1.25x base input and only pays back from
   * the second request against the same prefix — true of every agent turn (the
   * loop re-sends the prefix once per iteration), not of one-shot calls.
   *
   * Requires `modelString`: breakpoints are placed only for providers that need
   * an explicit marker — see `PROVIDERS_REQUIRING_CACHE_BREAKPOINTS`, which is
   * the single source of truth for that set. Personas may run any registry
   * model, and a provider that caches automatically needs nothing here.
   */
  cachePrefix?: boolean
}

export interface GenerateTextWithToolsResult {
  text: string
  toolCalls: Array<{ toolCallId: string; toolName: string; input: unknown }>
  response: { messages: ModelMessage[] }
  /**
   * What the call cost, when the caller passed `modelString` (the cost recorder
   * needs it to parse the provider). Production accounts for this through
   * `maybeRecordUsage` and never reads it here; it is returned so a caller that
   * is NOT writing `ai_usage_records` — the eval runner — can still attribute
   * tokens and cost to the model that ran. Absent on implementations that do
   * not compute usage (the enclave AI).
   */
  usage?: UsageWithCost
}

export interface GenerateObjectOptions<T extends z.ZodType> {
  model: string
  schema: T
  messages: Message[]
  maxTokens?: number
  temperature?: number
  reasoningEffort?: ReasoningEffort
  /** Set to false to disable repair, or provide custom repair function */
  repair?: RepairFunction | false
  telemetry?: TelemetryConfig
  /** When provided, usage will be recorded to the database */
  context?: CostContext
  /** Abort signal for graceful cancellation / per-call timeouts */
  abortSignal?: AbortSignal
}

export interface EmbedOptions {
  model: string
  value: string
  telemetry?: TelemetryConfig
  /** When provided, usage will be recorded to the database */
  context?: CostContext
  /** Abort signal for graceful cancellation / per-call timeouts */
  abortSignal?: AbortSignal
}

export interface EmbedManyOptions {
  model: string
  values: string[]
  telemetry?: TelemetryConfig
  /** When provided, usage will be recorded to the database */
  context?: CostContext
  /** Abort signal for graceful cancellation / per-call timeouts */
  abortSignal?: AbortSignal
}

// Response types from AI SDK
type GenerateTextResponse = Awaited<ReturnType<typeof aiGenerateText>>
type EmbedResponse = Awaited<ReturnType<typeof aiEmbed>>
type EmbedManyResponse = Awaited<ReturnType<typeof aiEmbedMany>>

/** Usage info with optional cost from provider */
export interface UsageWithCost {
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
  /**
   * Prompt tokens served from the provider's cache rather than reprocessed.
   * A share of `promptTokens`, not an addition to it. Absent when the provider
   * reports no cache detail. Read this against `promptTokens` to get a hit rate
   * per call site — the only way to tell whether a cache breakpoint is paying
   * for its 1.25x write premium on a given surface.
   */
  cachedPromptTokens?: number
  reasoningTokens?: number
  /** Cost in USD from OpenRouter, if available */
  cost?: number
}

export interface TextResult {
  value: string
  response: GenerateTextResponse
  /** Usage with cost extracted from provider metadata */
  usage: UsageWithCost
}

export interface ObjectResult<T> {
  value: T
  response: {
    usage: {
      readonly promptTokens?: number
      readonly completionTokens?: number
      readonly totalTokens?: number
    }
  }
  /** Usage with cost extracted from provider metadata */
  usage: UsageWithCost
}

export interface SingleEmbedResult {
  value: Embedding
  response: EmbedResponse
  /** Usage with cost extracted from provider metadata */
  usage: UsageWithCost
}

export interface ManyEmbedResult {
  value: Embedding[]
  response: EmbedManyResponse
  /** Usage with cost extracted from provider metadata */
  usage: UsageWithCost
}

export type RepairFunction = (args: { text: string }) => Promise<string> | string

export interface AI {
  // Generation
  generateText(options: GenerateTextOptions): Promise<TextResult>
  generateTextWithTools(options: GenerateTextWithToolsOptions): Promise<GenerateTextWithToolsResult>
  generateObject<T extends z.ZodType>(options: GenerateObjectOptions<T>): Promise<ObjectResult<z.infer<T>>>

  // Embeddings
  embed(options: EmbedOptions): Promise<SingleEmbedResult>
  embedMany(options: EmbedManyOptions): Promise<ManyEmbedResult>

  // Model access (for advanced use cases)
  getLanguageModel(modelString: string): LanguageModel
  getEmbeddingModel(modelString: string): EmbeddingModel

  // Parsing
  parseModel(modelString: string): ParsedModel
}

/**
 * Model providers whose prompt caching requires an explicit breakpoint on the
 * request. Measured against OpenRouter, 2026-07-26: both Anthropic and Gemini
 * cache the marked prefix and cache NOTHING without the marker. OpenAI is
 * deliberately absent — its caching is automatic and needs no marker, so
 * marking it would be noise.
 *
 * Keyed on `modelProvider` (the segment inside the OpenRouter path), so it is
 * unaffected by which upstream OpenRouter routes to — an Anthropic model served
 * via Bedrock still caches on this marker.
 */
const PROVIDERS_REQUIRING_CACHE_BREAKPOINTS = new Set(["anthropic", "google"])

/**
 * Whether a model provider needs an explicit cache breakpoint. Takes the bare
 * provider segment rather than a `provider:model` string because the enclave —
 * which places its own breakpoints over a hand-rolled OpenAI transport — only
 * ever holds the OpenRouter path (`anthropic/claude-sonnet-5`), never the
 * prefixed form `parseModelId` expects. Exported so that host and enclave read
 * the same set instead of keeping two copies that can drift apart (INV-33).
 */
export function providerRequiresCacheBreakpoints(modelProvider: string): boolean {
  return PROVIDERS_REQUIRING_CACHE_BREAKPOINTS.has(modelProvider)
}

/**
 * Merge a cache breakpoint into a message's provider options. Merges *inside*
 * the `openrouter` key rather than replacing it — a message may already carry
 * sibling options there (reasoning effort, transforms) that a shallow spread
 * would silently drop.
 */
function withCacheControl(existing?: ModelMessage["providerOptions"]): ModelMessage["providerOptions"] {
  return {
    ...existing,
    openrouter: { ...existing?.openrouter, cacheControl: { type: "ephemeral" } },
  }
}

/**
 * Rewrite a request to carry Anthropic prompt-cache breakpoints.
 *
 * The system prompt has to move into the message list: the AI SDK's top-level
 * `system` string has nowhere to carry `providerOptions`, and the breakpoint
 * must ride the message that ends the stable prefix. The AI SDK renders a
 * top-level `system` into exactly this message anyway, so the wire shape is
 * unchanged apart from `cache_control`.
 *
 * Returns the request untouched for providers that don't take an explicit
 * breakpoint. Losing the optimization is the correct degradation there — it
 * changes cost, never behavior.
 */
export function applyCacheBreakpoints(params: {
  system?: string
  /**
   * Per-turn system content (temporal grounding, turn digests, retrieved
   * context). Emitted as a second, UNMARKED system message after the
   * breakpoint, so changing it leaves the cached prefix intact — that is the
   * difference between reusing the prefix across turns and reusing nothing.
   */
  volatileSystem?: string
  messages: ModelMessage[]
  modelString?: string
}): {
  system?: string
  messages: ModelMessage[]
} {
  const { system, volatileSystem, messages, modelString } = params
  if (!modelString || !providerRequiresCacheBreakpoints(parseModelId(modelString).modelProvider)) {
    // No breakpoint to split on, so the halves must be rejoined — returning
    // only `system` would silently drop the volatile tail from the prompt.
    const joined = [system, volatileSystem].filter(Boolean).join("\n\n")
    return { system: joined || undefined, messages }
  }

  const out: ModelMessage[] = []
  if (system) {
    out.push({ role: "system", content: system, providerOptions: withCacheControl() })
  }
  if (volatileSystem) {
    out.push({ role: "system", content: volatileSystem })
  }
  out.push(...messages)

  // Second breakpoint on the newest conversation message, so the history an
  // agent loop grows each iteration is read back rather than reprocessed. It
  // must never land on the volatile system message: that content changes every
  // turn, so caching it would pay a write premium for a span nothing can reuse.
  const last = messages.length > 0 ? out.at(-1) : undefined
  if (last) {
    out[out.length - 1] = markOneCacheBlock(last)
  }

  return { system: undefined, messages: out }
}

/**
 * Put exactly ONE cache breakpoint on a message.
 *
 * A message-level breakpoint is not always one wire block. `@openrouter/ai-sdk-provider`
 * expands a `tool` message into one wire message PER RESULT and copies the
 * message-level `cache_control` onto every one of them. A turn that calls four
 * tools in a single iteration therefore ends with four blocks on its tool
 * message, and Anthropic rejects the request outright at five (system + four):
 *
 *   AI_APICallError: A maximum of 4 blocks with cache_control may be provided.
 *
 * That is a hard 400 that kills the turn after the tools have already run and
 * written their state — the user sees a failed session that did everything.
 *
 * Marking the last tool result instead yields one block and still caches the
 * whole message: the provider reads a result's own `providerOptions` when the
 * message carries none.
 *
 * `tool` is the ONLY role that needs this. `assistant` and `system` accumulate
 * into a single wire message; a multi-part `user` message looks like it would
 * fan out but does not — the provider applies the message-level mark to the
 * last TEXT part only. Marking a part by hand for those roles would either be
 * read by nothing or move the breakpoint off the block the provider chose.
 */
function markOneCacheBlock(message: ModelMessage): ModelMessage {
  const parts = message.content
  if (message.role !== "tool" || !Array.isArray(parts) || parts.length === 0) {
    return { ...message, providerOptions: withCacheControl(message.providerOptions) } as ModelMessage
  }

  const results = parts as Array<{ providerOptions?: ModelMessage["providerOptions"] }>
  const marked = results.map((part, index) =>
    index === results.length - 1 ? { ...part, providerOptions: withCacheControl(part.providerOptions) } : part
  )
  return { ...message, content: marked } as ModelMessage
}

/**
 * Parse a provider:model string into its components.
 *
 * Format: "provider:modelPath"
 *
 * Examples:
 *   "openrouter:anthropic/claude-haiku-4.5" → {
 *     provider: "openrouter",
 *     modelId: "anthropic/claude-haiku-4.5",
 *     modelProvider: "anthropic",
 *     modelName: "claude-haiku-4.5"
 *   }
 *
 *   "anthropic:claude-sonnet-4-20250514" → {
 *     provider: "anthropic",
 *     modelId: "claude-sonnet-4-20250514",
 *     modelProvider: "anthropic",
 *     modelName: "claude-sonnet-4-20250514"
 *   }
 */
export function parseModelId(providerModelString: string): ParsedModel {
  const colonIndex = providerModelString.indexOf(":")
  if (colonIndex === -1) {
    throw new Error(`Invalid provider:model format: "${providerModelString}". Expected format: "provider:model_id"`)
  }

  const provider = providerModelString.slice(0, colonIndex)
  const modelId = providerModelString.slice(colonIndex + 1)

  if (!provider || !modelId) {
    throw new Error(`Invalid provider:model format: "${providerModelString}". Both provider and model_id are required.`)
  }

  // Extract modelProvider from modelId if it contains a path separator
  let modelProvider = provider
  let modelName = modelId

  if (modelId.includes("/")) {
    const slashIndex = modelId.indexOf("/")
    modelProvider = modelId.slice(0, slashIndex)
    modelName = modelId.slice(slashIndex + 1)
  }

  return { provider, modelId, modelProvider, modelName }
}

export function extractUsageWithCost(response: {
  usage?:
    | {
        promptTokens?: number
        completionTokens?: number
        totalTokens?: number
        outputTokenDetails?: { reasoningTokens?: number }
      }
    | { tokens?: number }
  providerMetadata?: {
    openrouter?: {
      usage?: {
        cost?: number
        totalTokens?: number
        promptTokens?: number
        completionTokens?: number
        promptTokensDetails?: { cachedTokens?: number }
        completionTokensDetails?: { reasoningTokens?: number }
      }
    }
  }
}): UsageWithCost {
  const usage = response.usage ?? {}
  const openrouterUsage = response.providerMetadata?.openrouter?.usage

  if ("tokens" in usage && usage.tokens !== undefined) {
    return { totalTokens: usage.tokens, cost: openrouterUsage?.cost }
  }

  const langUsage = usage as {
    promptTokens?: number
    completionTokens?: number
    totalTokens?: number
    outputTokenDetails?: { reasoningTokens?: number }
  }
  return {
    promptTokens: openrouterUsage?.promptTokens ?? langUsage.promptTokens,
    completionTokens: openrouterUsage?.completionTokens ?? langUsage.completionTokens,
    totalTokens: openrouterUsage?.totalTokens ?? langUsage.totalTokens,
    cachedPromptTokens: openrouterUsage?.promptTokensDetails?.cachedTokens,
    reasoningTokens:
      langUsage.outputTokenDetails?.reasoningTokens ?? openrouterUsage?.completionTokensDetails?.reasoningTokens,
    cost: openrouterUsage?.cost,
  }
}

export function createAI(config: AIConfig): AI {
  const providers = {
    openrouter: config.openrouter ? createOpenRouter({ apiKey: config.openrouter.apiKey }) : null,
  }

  const defaultRepair = config.defaults?.repair ?? stripMarkdownFences

  function getLanguageModel(modelString: string): LanguageModel {
    const { provider, modelId } = parseModelId(modelString)

    switch (provider) {
      case "openrouter":
        if (!providers.openrouter) {
          throw new Error("OpenRouter not configured. Set OPENROUTER_API_KEY or provide openrouter.apiKey in config.")
        }
        logger.debug({ provider, modelId }, "Creating language model instance")
        // Enable usage tracking to get cost from OpenRouter response
        return providers.openrouter.chat(modelId, { usage: { include: true } })
      default:
        throw new Error(`Unsupported provider: "${provider}". Currently supported: openrouter`)
    }
  }

  function getEmbeddingModel(modelString: string): EmbeddingModel {
    const { provider, modelId } = parseModelId(modelString)

    switch (provider) {
      case "openrouter":
        if (!providers.openrouter) {
          throw new Error("OpenRouter not configured. Set OPENROUTER_API_KEY or provide openrouter.apiKey in config.")
        }
        logger.debug({ provider, modelId }, "Creating embedding model instance")
        // Enable usage tracking to get cost from OpenRouter response
        return providers.openrouter.textEmbeddingModel(modelId, { usage: { include: true } })
      default:
        throw new Error(`Unsupported embedding provider: "${provider}". Currently supported: openrouter`)
    }
  }

  /**
   * Denies before the provider sees the request. Calls without a context carry
   * no workspace to charge, so there is nothing to admit them against.
   */
  async function admit(context: CostContext | undefined, functionId: string): Promise<void> {
    if (!config.spendGate || !context) return
    const request = { workspaceId: context.workspaceId, userId: context.userId, functionId }
    const decision = await config.spendGate.admit(request)
    if (decision.allowed) return
    logger.warn({ ...request, reason: decision.reason }, "AI call denied by spend limit")
    throw new AISpendDeniedError(request, decision.reason)
  }

  // ai@7 removed built-in OpenTelemetry: TelemetryOptions carries no metadata.
  // Our own TelemetryConfig.metadata still flows to the access-log disclose sink
  // and the cost recorder; only the SDK channel is gone.
  function buildTelemetry(telemetry?: TelemetryConfig) {
    if (!telemetry) return undefined

    return {
      isEnabled: true,
      functionId: telemetry.functionId,
    } as const
  }

  /**
   * Emit a `disclose` access-log row for this egress, if a sink is configured.
   * Fired synchronously at send time — the content crosses the trust boundary the
   * moment it is dispatched, so a provider call that errors after receiving the
   * prompt must still produce a row (design §2). Best-effort: a sync throw or a
   * returned rejection is swallowed so audit never fails or delays the AI call.
   * When `modelString` is absent or not `provider:model` the egress still
   * happened, so it records with provider/model `unknown` rather than dropping.
   */
  function maybeDisclose(params: {
    context?: CostContext
    functionId: string
    modelString?: string
    metadata?: Record<string, unknown>
  }): void {
    if (!config.accessLogSink) return
    try {
      let provider = "unknown"
      let modelId = "unknown"
      if (params.modelString) {
        try {
          const parsed = parseModelId(params.modelString)
          provider = parsed.provider
          modelId = parsed.modelId
        } catch {
          // modelString present but not "provider:model" — keep unknown/unknown.
        }
      }
      const result = config.accessLogSink.record({
        functionId: params.functionId,
        provider,
        modelId,
        context: params.context,
        metadata: params.metadata,
      })
      if (result && typeof (result as Promise<void>).catch === "function") {
        void (result as Promise<void>).catch((error) => {
          logger.error({ error, functionId: params.functionId }, "Failed to record AI access-log disclose")
        })
      }
    } catch (error) {
      logger.error({ error, functionId: params.functionId }, "Failed to record AI access-log disclose")
    }
  }

  async function maybeRecordUsage(params: {
    context?: CostContext
    functionId: string
    modelString: string
    usage: UsageWithCost
    latencyMs?: number
    metadata?: Record<string, unknown>
  }): Promise<void> {
    if (!config.costRecorder || !params.context) return

    const parsed = parseModelId(params.modelString)

    try {
      await config.costRecorder.recordUsage({
        workspaceId: params.context.workspaceId,
        userId: params.context.userId,
        sessionId: params.context.sessionId,
        functionId: params.functionId,
        model: parsed.modelId,
        provider: parsed.provider,
        origin: params.context.origin ?? "system",
        usage: params.usage,
        latencyMs: params.latencyMs,
        metadata: params.metadata,
      })
    } catch (error) {
      logger.error(
        { error, functionId: params.functionId, model: params.modelString },
        "Failed to record AI usage cost"
      )
    }
  }

  return {
    parseModel: parseModelId,
    getLanguageModel,
    getEmbeddingModel,

    async generateText(options) {
      await admit(options.context, options.telemetry?.functionId ?? "generateText")
      const model = getLanguageModel(options.model)
      maybeDisclose({
        context: options.context,
        functionId: options.telemetry?.functionId ?? "generateText",
        modelString: options.model,
        metadata: options.telemetry?.metadata as Record<string, unknown> | undefined,
      })
      const startedAt = Date.now()
      const response = await aiGenerateText({
        model,
        // Our Message type is compatible with AI SDK's ModelMessage at runtime
        // The cast is needed because our role type is a union while SDK uses discriminated types
        messages: options.messages as ModelMessage[],
        // ai@7 throws AI_InvalidPromptError on any role: "system" message unless this is set;
        // our callers express system prompts as system-role messages.
        allowSystemInMessages: true,
        maxOutputTokens: options.maxTokens,
        temperature: options.temperature,
        abortSignal: options.abortSignal,
        ...(options.reasoningEffort
          ? { providerOptions: { openrouter: { reasoning: { effort: options.reasoningEffort, exclude: true } } } }
          : {}),
        experimental_telemetry: buildTelemetry(options.telemetry),
      })

      const usage = extractUsageWithCost(response)
      logger.debug({ usage, model: options.model }, "AI generateText completed with usage")

      await maybeRecordUsage({
        context: options.context,
        functionId: options.telemetry?.functionId ?? "generateText",
        modelString: options.model,
        usage,
        latencyMs: Date.now() - startedAt,
        metadata: options.telemetry?.metadata as Record<string, unknown> | undefined,
      })

      return {
        value: response.text,
        response,
        usage,
      }
    },

    async generateTextWithTools(options: GenerateTextWithToolsOptions): Promise<GenerateTextWithToolsResult> {
      await admit(options.context, options.telemetry?.functionId ?? "generateTextWithTools")
      // Disclose fires even without `modelString`: the egress happened, so a
      // provider/model `unknown` row beats silence. Cost recording below stays
      // gated on `modelString` (the recorder needs the parseable identifier).
      maybeDisclose({
        context: options.context,
        functionId: options.telemetry?.functionId ?? "generateTextWithTools",
        modelString: options.modelString,
        metadata: options.telemetry?.metadata as Record<string, unknown> | undefined,
      })
      const { system, messages } = options.cachePrefix
        ? applyCacheBreakpoints({
            system: options.system,
            volatileSystem: options.volatileSystem,
            messages: options.messages,
            modelString: options.modelString,
          })
        : {
            system: [options.system, options.volatileSystem].filter(Boolean).join("\n\n") || undefined,
            messages: options.messages,
          }

      const startedAt = Date.now()
      const response = await aiGenerateText({
        model: options.model,
        system,
        messages,
        allowSystemInMessages: true,
        tools: options.tools,
        maxOutputTokens: options.maxTokens,
        temperature: options.temperature,
        abortSignal: options.abortSignal,
        experimental_telemetry: buildTelemetry(options.telemetry),
      })

      // Usage recording requires the original model string because the resolved
      // LanguageModel instance does not carry the provider:model prefix the cost
      // recorder expects. Callers that want tracked usage must pass `modelString`
      // alongside `context` (agent loops do this via AgentRuntime).
      let usage: UsageWithCost | undefined
      if (options.modelString) {
        usage = extractUsageWithCost(response)
        logger.debug(
          { usage, model: options.modelString, functionId: options.telemetry?.functionId },
          "AI generateTextWithTools completed with usage"
        )

        await maybeRecordUsage({
          context: options.context,
          functionId: options.telemetry?.functionId ?? "generateTextWithTools",
          modelString: options.modelString,
          usage,
          latencyMs: Date.now() - startedAt,
          metadata: options.telemetry?.metadata as Record<string, unknown> | undefined,
        })
      }

      return {
        text: response.text,
        toolCalls: response.toolCalls.map((tc) => ({
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          input: tc.input,
        })),
        response: { messages: response.response.messages },
        usage,
      }
    },

    async generateObject<T extends z.ZodType>(options: GenerateObjectOptions<T>): Promise<ObjectResult<z.infer<T>>> {
      await admit(options.context, options.telemetry?.functionId ?? "generateObject")
      const model = getLanguageModel(options.model)
      const repair = options.repair === false ? undefined : (options.repair ?? defaultRepair)

      maybeDisclose({
        context: options.context,
        functionId: options.telemetry?.functionId ?? "generateObject",
        modelString: options.model,
        metadata: options.telemetry?.metadata as Record<string, unknown> | undefined,
      })
      const startedAt = Date.now()
      // @ts-expect-error AI SDK generateObject has complex generics; we validate schema type at our interface level
      const response = await aiGenerateObject({
        model,
        schema: options.schema,
        // Our Message type is compatible with AI SDK's ModelMessage at runtime
        messages: options.messages as ModelMessage[],
        allowSystemInMessages: true,
        maxOutputTokens: options.maxTokens,
        temperature: options.temperature,
        abortSignal: options.abortSignal,
        ...(options.reasoningEffort
          ? { providerOptions: { openrouter: { reasoning: { effort: options.reasoningEffort, exclude: true } } } }
          : {}),
        experimental_repairText: repair,
        experimental_telemetry: buildTelemetry(options.telemetry),
      })

      const usage = extractUsageWithCost(response)
      logger.debug({ usage, model: options.model }, "AI generateObject completed with usage")

      await maybeRecordUsage({
        context: options.context,
        functionId: options.telemetry?.functionId ?? "generateObject",
        modelString: options.model,
        usage,
        latencyMs: Date.now() - startedAt,
        metadata: options.telemetry?.metadata as Record<string, unknown> | undefined,
      })

      return {
        value: response.object as z.infer<T>,
        response: {
          usage: response.usage,
        },
        usage,
      }
    },

    async embed(options) {
      await admit(options.context, options.telemetry?.functionId ?? "embed")
      const model = getEmbeddingModel(options.model)
      maybeDisclose({
        context: options.context,
        functionId: options.telemetry?.functionId ?? "embed",
        modelString: options.model,
        metadata: options.telemetry?.metadata as Record<string, unknown> | undefined,
      })
      const startedAt = Date.now()
      const response = await aiEmbed({
        model,
        value: options.value,
        abortSignal: options.abortSignal,
        experimental_telemetry: buildTelemetry(options.telemetry),
      })

      const usage = extractUsageWithCost(response)
      logger.debug({ usage, model: options.model }, "AI embed completed with usage")

      await maybeRecordUsage({
        context: options.context,
        functionId: options.telemetry?.functionId ?? "embed",
        modelString: options.model,
        usage,
        latencyMs: Date.now() - startedAt,
        metadata: options.telemetry?.metadata as Record<string, unknown> | undefined,
      })

      return {
        value: response.embedding,
        response,
        usage,
      }
    },

    async embedMany(options) {
      await admit(options.context, options.telemetry?.functionId ?? "embedMany")
      const model = getEmbeddingModel(options.model)
      const embedManyMetadata = { ...options.telemetry?.metadata, count: options.values.length } as Record<
        string,
        unknown
      >
      maybeDisclose({
        context: options.context,
        functionId: options.telemetry?.functionId ?? "embedMany",
        modelString: options.model,
        metadata: embedManyMetadata,
      })
      const startedAt = Date.now()
      const response = await aiEmbedMany({
        model,
        values: options.values,
        abortSignal: options.abortSignal,
        experimental_telemetry: buildTelemetry(options.telemetry),
      })

      const usage = extractUsageWithCost(response)
      logger.debug({ usage, model: options.model, count: options.values.length }, "AI embedMany completed with usage")

      await maybeRecordUsage({
        context: options.context,
        functionId: options.telemetry?.functionId ?? "embedMany",
        modelString: options.model,
        usage,
        latencyMs: Date.now() - startedAt,
        metadata: embedManyMetadata,
      })

      return {
        value: response.embeddings,
        response,
        usage,
      }
    },
  }
}

/**
 * Returns true if the given error represents an abort or per-call timeout.
 *
 * Covers native AbortError/TimeoutError names from both `Error` and `DOMException`
 * so callers can treat aborted AI calls as soft "no result" rather than scary warnings.
 */
export function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false
  const name = (err as { name?: unknown }).name
  if (typeof name !== "string") return false
  return name === "AbortError" || name === "TimeoutError"
}
