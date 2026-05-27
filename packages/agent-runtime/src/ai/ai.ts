/**
 * AI SDK Wrapper
 *
 * Provides a clean abstraction over the Vercel AI SDK with:
 * - No `experimental_` prefixes
 * - Automatic repair for generateObject
 * - Unified `{ value, response }` return type
 * - Extended model ID parsing (extracts modelProvider)
 * - LangChain integration for LangGraph
 */

import {
  generateText as aiGenerateText,
  generateObject as aiGenerateObject,
  embed as aiEmbed,
  embedMany as aiEmbedMany,
} from "ai"
import type { Embedding, LanguageModel, EmbeddingModel, ModelMessage, Tool } from "ai"
import type { z } from "zod"
import { createOpenRouter } from "@openrouter/ai-sdk-provider"
import { ChatOpenAI } from "@langchain/openai"
import { stripMarkdownFences } from "./text-utils"
import { CostTracker } from "./openrouter-cost-interceptor"
import { logger } from "../logger"

// Re-export cost tracking utilities for consumers
export { CostTracker, type CapturedUsage } from "./openrouter-cost-interceptor"
export { getCostTrackingCallbacks, CostTrackingCallback } from "./cost-tracking-callback"

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

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
    metadata?: Record<string, unknown>
  }): Promise<void>
}

export interface AIConfig {
  openrouter?: { apiKey: string }
  defaults?: {
    repair?: RepairFunction
  }
  /** When provided, usage will be recorded after each AI call (requires context in options) */
  costRecorder?: CostRecorder
  /** When provided, model degradation and hard-stop policies are enforced before AI calls */
  budgetEnforcer?: BudgetEnforcer
}

export interface TelemetryConfig {
  functionId: string
  metadata?: Record<string, string | number | boolean | undefined>
}

/** Context for cost tracking - when provided, usage will be recorded */
export interface CostContext {
  workspaceId: string
  userId?: string
  sessionId?: string
  /** Origin of the AI call - defaults to 'system' if not specified */
  origin?: AIOrigin
}

export interface BudgetStatus {
  allowed: boolean
  reason?: "within_budget" | "soft_limit" | "hard_limit"
  currentUsageUsd: number
  budgetUsd: number
  percentUsed: number
  recommendedModel?: string
}

export interface BudgetEnforcer {
  checkBudget(workspaceId: string, requestedModel?: string): Promise<BudgetStatus>
}

export class AIBudgetExceededError extends Error {
  readonly workspaceId: string
  readonly model: string
  readonly percentUsed: number
  readonly currentUsageUsd: number
  readonly budgetUsd: number
  readonly reason: "hard_limit"

  constructor(params: {
    workspaceId: string
    model: string
    percentUsed: number
    currentUsageUsd: number
    budgetUsd: number
  }) {
    super(
      `AI budget hard limit reached for workspace ${params.workspaceId}. Requested model "${params.model}" is blocked.`
    )
    this.name = "AIBudgetExceededError"
    this.workspaceId = params.workspaceId
    this.model = params.model
    this.percentUsed = params.percentUsed
    this.currentUsageUsd = params.currentUsageUsd
    this.budgetUsd = params.budgetUsd
    this.reason = "hard_limit"
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

export interface GenerateTextOptions {
  model: string
  messages: Message[]
  maxTokens?: number
  temperature?: number
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
  messages: ModelMessage[]
  tools?: Record<string, Tool<any, any>>
  maxTokens?: number
  temperature?: number
  telemetry?: TelemetryConfig
  /** When provided with `modelString`, usage will be recorded to the database */
  context?: CostContext
  /** Abort signal for graceful cancellation / per-call timeouts */
  abortSignal?: AbortSignal
}

export interface GenerateTextWithToolsResult {
  text: string
  toolCalls: Array<{ toolCallId: string; toolName: string; input: unknown }>
  response: { messages: ModelMessage[] }
}

export interface GenerateObjectOptions<T extends z.ZodType> {
  model: string
  schema: T
  messages: Message[]
  maxTokens?: number
  temperature?: number
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

export interface LangChainModelResult {
  model: ChatOpenAI
  effectiveModel: string
  budgetMetadata: Record<string, string | number | boolean>
}

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
  getEmbeddingModel(modelString: string): EmbeddingModel<string>
  getLangChainModel(modelString: string, context?: CostContext): Promise<LangChainModelResult>

  // Cost tracking for LangChain/LangGraph calls
  /** CostTracker instance for this AI wrapper - use with getCostTrackingCallbacks */
  costTracker: CostTracker

  // Parsing
  parseModel(modelString: string): ParsedModel
}

interface BudgetPolicyDecision {
  requestedModel: string
  effectiveModel: string
  reason: "within_budget" | "soft_limit" | "not_checked"
  policyChecked: boolean
  modelDegraded: boolean
  currentUsageUsd?: number
  budgetUsd?: number
  percentUsed?: number
}

// -----------------------------------------------------------------------------
// Model ID Parsing
// -----------------------------------------------------------------------------

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

// -----------------------------------------------------------------------------
// Factory
// -----------------------------------------------------------------------------

export function createAI(config: AIConfig): AI {
  // Initialize providers
  const providers = {
    openrouter: config.openrouter ? createOpenRouter({ apiKey: config.openrouter.apiKey }) : null,
  }

  // Store API keys for LangChain (needs raw key, not provider instance)
  const apiKeys = {
    openrouter: config.openrouter?.apiKey ?? null,
  }

  const defaultRepair = config.defaults?.repair ?? stripMarkdownFences

  // Create CostTracker instance for this AI wrapper
  // This is used for LangChain/LangGraph calls via getCostTrackingCallbacks
  const costTracker = new CostTracker()

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

  function getEmbeddingModel(modelString: string): EmbeddingModel<string> {
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

  // Create cost-capturing fetch from our CostTracker instance
  const costCapturingFetch = costTracker.createInterceptingFetch()

  async function resolveBudgetPolicy(params: {
    modelString: string
    context?: CostContext
    functionId: string
  }): Promise<BudgetPolicyDecision> {
    if (!config.budgetEnforcer || !params.context?.workspaceId) {
      return {
        requestedModel: params.modelString,
        effectiveModel: params.modelString,
        reason: "not_checked",
        policyChecked: false,
        modelDegraded: false,
      }
    }

    const status = await config.budgetEnforcer.checkBudget(params.context.workspaceId, params.modelString)

    if (!status.allowed && status.reason === "hard_limit") {
      logger.warn(
        {
          workspaceId: params.context.workspaceId,
          functionId: params.functionId,
          requestedModel: params.modelString,
          currentUsageUsd: status.currentUsageUsd,
          budgetUsd: status.budgetUsd,
          percentUsed: status.percentUsed,
        },
        "Blocking AI call due to workspace hard budget limit"
      )

      throw new AIBudgetExceededError({
        workspaceId: params.context.workspaceId,
        model: params.modelString,
        percentUsed: status.percentUsed,
        currentUsageUsd: status.currentUsageUsd,
        budgetUsd: status.budgetUsd,
      })
    }

    if (status.reason === "soft_limit" && status.recommendedModel && status.recommendedModel !== params.modelString) {
      logger.info(
        {
          workspaceId: params.context.workspaceId,
          functionId: params.functionId,
          requestedModel: params.modelString,
          recommendedModel: status.recommendedModel,
          percentUsed: status.percentUsed,
        },
        "Applying budget-based model degradation before AI call"
      )
      return {
        requestedModel: params.modelString,
        effectiveModel: status.recommendedModel,
        reason: "soft_limit",
        policyChecked: true,
        modelDegraded: true,
        currentUsageUsd: status.currentUsageUsd,
        budgetUsd: status.budgetUsd,
        percentUsed: status.percentUsed,
      }
    }

    return {
      requestedModel: params.modelString,
      effectiveModel: params.modelString,
      reason: "within_budget",
      policyChecked: true,
      modelDegraded: false,
      currentUsageUsd: status.currentUsageUsd,
      budgetUsd: status.budgetUsd,
      percentUsed: status.percentUsed,
    }
  }

  function buildBudgetTelemetryMetadata(
    decision: BudgetPolicyDecision
  ): Record<string, string | number | boolean | undefined> {
    return {
      budget_policy_checked: decision.policyChecked,
      budget_policy_reason: decision.reason,
      budget_model_requested: decision.requestedModel,
      budget_model_effective: decision.effectiveModel,
      budget_model_degraded: decision.modelDegraded,
      budget_percent_used: decision.percentUsed,
      budget_current_usage_usd: decision.currentUsageUsd,
      budget_limit_usd: decision.budgetUsd,
    }
  }

  function compactMetadata(
    metadata: Record<string, string | number | boolean | undefined>
  ): Record<string, string | number | boolean> {
    const compact: Record<string, string | number | boolean> = {}
    for (const [key, value] of Object.entries(metadata)) {
      if (value !== undefined) {
        compact[key] = value
      }
    }
    return compact
  }

  function createBudgetAwareLangChainFetch(params: {
    context?: CostContext
    fallbackModelString: string
  }): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
    return async (input, init) => {
      let requestBodyObject: Record<string, unknown> | null = null
      let requestedModelString = params.fallbackModelString

      if (typeof init?.body === "string") {
        try {
          const parsed = JSON.parse(init.body)
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            requestBodyObject = parsed as Record<string, unknown>
            const bodyModel = requestBodyObject.model
            if (typeof bodyModel === "string" && bodyModel.length > 0) {
              requestedModelString = bodyModel.includes(":") ? bodyModel : `openrouter:${bodyModel}`
            }
          }
        } catch (error) {
          logger.warn({ error }, "Failed to parse LangChain request body for budget enforcement")
        }
      }

      const budgetDecision = await resolveBudgetPolicy({
        modelString: requestedModelString,
        context: params.context,
        functionId: "langchain-model-invoke",
      })

      let nextInit = init
      if (requestBodyObject && budgetDecision.effectiveModel !== requestedModelString) {
        const { modelId: effectiveModelId } = parseModelId(budgetDecision.effectiveModel)
        nextInit = {
          ...init,
          body: JSON.stringify({
            ...requestBodyObject,
            model: effectiveModelId,
          }),
        }
      }

      return costCapturingFetch(input, nextInit)
    }
  }

  async function getLangChainModel(modelString: string, context?: CostContext): Promise<LangChainModelResult> {
    const initialBudgetDecision = await resolveBudgetPolicy({
      modelString,
      context,
      functionId: "langchain-model",
    })

    const { provider, modelId } = parseModelId(initialBudgetDecision.effectiveModel)

    switch (provider) {
      case "openrouter":
        if (!apiKeys.openrouter) {
          throw new Error("OpenRouter not configured. Set OPENROUTER_API_KEY or provide openrouter.apiKey in config.")
        }
        logger.debug({ provider, modelId, requestedModel: modelString }, "Creating LangChain model instance")
        return {
          model: new ChatOpenAI({
            model: modelId,
            apiKey: apiKeys.openrouter,
            configuration: {
              baseURL: OPENROUTER_BASE_URL,
              // Intercept every request to enforce budget policy and capture usage
              fetch: createBudgetAwareLangChainFetch({
                context,
                fallbackModelString: initialBudgetDecision.effectiveModel,
              }),
            },
          }),
          effectiveModel: initialBudgetDecision.effectiveModel,
          budgetMetadata: compactMetadata(buildBudgetTelemetryMetadata(initialBudgetDecision)),
        }
      default:
        throw new Error(`Unsupported LangChain provider: "${provider}". Currently supported: openrouter`)
    }
  }

  function buildTelemetry(telemetry?: TelemetryConfig, modelString?: string, budgetDecision?: BudgetPolicyDecision) {
    if (!telemetry) return undefined

    // Include parsed model info in metadata for Langfuse model matching
    let modelMetadata: Record<string, string | number | boolean | undefined> = {}
    if (modelString) {
      const parsed = parseModelId(modelString)
      modelMetadata = {
        model_id: parsed.modelId,
        model_provider: parsed.modelProvider,
        model_name: parsed.modelName,
      }
    }

    const budgetMetadata = budgetDecision ? buildBudgetTelemetryMetadata(budgetDecision) : {}

    return {
      isEnabled: true,
      functionId: telemetry.functionId,
      metadata: {
        ...modelMetadata,
        ...budgetMetadata,
        ...telemetry.metadata,
      },
    } as const
  }

  /**
   * Extract usage with cost from AI SDK response.
   * OpenRouter provides cost via providerMetadata.openrouter.usage.cost
   *
   * Handles two different usage shapes:
   * - Language model: { promptTokens, completionTokens, totalTokens }
   * - Embedding model: { tokens }
   */
  function extractUsageWithCost(response: {
    // Language model usage shape
    usage?:
      | { promptTokens?: number; completionTokens?: number; totalTokens?: number }
      // Embedding model usage shape
      | { tokens?: number }
    // AI SDK v5 uses providerMetadata (not experimental_providerMetadata)
    providerMetadata?: {
      openrouter?: {
        usage?: {
          cost?: number
          totalTokens?: number
          promptTokens?: number
          completionTokens?: number
        }
      }
    }
  }): UsageWithCost {
    const usage = response.usage ?? {}
    // OpenRouter provides detailed usage via providerMetadata
    const openrouterUsage = response.providerMetadata?.openrouter?.usage

    // Handle embedding model usage (only has 'tokens')
    if ("tokens" in usage && usage.tokens !== undefined) {
      return {
        totalTokens: usage.tokens,
        cost: openrouterUsage?.cost,
      }
    }

    // Handle language model usage - prefer OpenRouter data if available
    const langUsage = usage as { promptTokens?: number; completionTokens?: number; totalTokens?: number }
    return {
      promptTokens: openrouterUsage?.promptTokens ?? langUsage.promptTokens,
      completionTokens: openrouterUsage?.completionTokens ?? langUsage.completionTokens,
      totalTokens: openrouterUsage?.totalTokens ?? langUsage.totalTokens,
      cost: openrouterUsage?.cost,
    }
  }

  /**
   * Record usage to cost service if context is provided.
   * Fire-and-forget to avoid blocking the AI call.
   */
  async function maybeRecordUsage(params: {
    context?: CostContext
    functionId: string
    modelString: string
    usage: UsageWithCost
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
    getLangChainModel,
    costTracker,

    async generateText(options) {
      const budgetDecision = await resolveBudgetPolicy({
        modelString: options.model,
        context: options.context,
        functionId: options.telemetry?.functionId ?? "generateText",
      })
      const effectiveModel = budgetDecision.effectiveModel
      const model = getLanguageModel(effectiveModel)
      const response = await aiGenerateText({
        model,
        // Our Message type is compatible with AI SDK's ModelMessage at runtime
        // The cast is needed because our role type is a union while SDK uses discriminated types
        messages: options.messages as ModelMessage[],
        maxOutputTokens: options.maxTokens,
        temperature: options.temperature,
        abortSignal: options.abortSignal,
        // @ts-expect-error AI SDK telemetry types are stricter than needed; our buildTelemetry output is compatible at runtime
        experimental_telemetry: buildTelemetry(options.telemetry, effectiveModel, budgetDecision),
      })

      const usage = extractUsageWithCost(response)
      logger.debug(
        { usage, requestedModel: options.model, model: effectiveModel },
        "AI generateText completed with usage"
      )

      await maybeRecordUsage({
        context: options.context,
        functionId: options.telemetry?.functionId ?? "generateText",
        modelString: effectiveModel,
        usage,
        metadata: options.telemetry?.metadata as Record<string, unknown> | undefined,
      })

      return {
        value: response.text,
        response,
        usage,
      }
    },

    async generateTextWithTools(options: GenerateTextWithToolsOptions): Promise<GenerateTextWithToolsResult> {
      const response = await aiGenerateText({
        model: options.model,
        system: options.system,
        messages: options.messages,
        tools: options.tools,
        maxOutputTokens: options.maxTokens,
        temperature: options.temperature,
        abortSignal: options.abortSignal,
        // @ts-expect-error AI SDK telemetry types are stricter than needed; our TelemetryConfig output is compatible at runtime
        experimental_telemetry: options.telemetry
          ? { isEnabled: true, functionId: options.telemetry.functionId, metadata: options.telemetry.metadata }
          : undefined,
      })

      // Usage recording requires the original model string because the resolved
      // LanguageModel instance does not carry the provider:model prefix the cost
      // recorder expects. Callers that want tracked usage must pass `modelString`
      // alongside `context` (agent loops do this via AgentRuntime).
      if (options.modelString) {
        const usage = extractUsageWithCost(response)
        logger.debug(
          { usage, model: options.modelString, functionId: options.telemetry?.functionId },
          "AI generateTextWithTools completed with usage"
        )

        await maybeRecordUsage({
          context: options.context,
          functionId: options.telemetry?.functionId ?? "generateTextWithTools",
          modelString: options.modelString,
          usage,
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
      }
    },

    async generateObject<T extends z.ZodType>(options: GenerateObjectOptions<T>): Promise<ObjectResult<z.infer<T>>> {
      const budgetDecision = await resolveBudgetPolicy({
        modelString: options.model,
        context: options.context,
        functionId: options.telemetry?.functionId ?? "generateObject",
      })
      const effectiveModel = budgetDecision.effectiveModel
      const model = getLanguageModel(effectiveModel)
      const repair = options.repair === false ? undefined : (options.repair ?? defaultRepair)

      // @ts-expect-error AI SDK generateObject has complex generics; we validate schema type at our interface level
      const response = await aiGenerateObject({
        model,
        schema: options.schema,
        // Our Message type is compatible with AI SDK's ModelMessage at runtime
        messages: options.messages as ModelMessage[],
        maxOutputTokens: options.maxTokens,
        temperature: options.temperature,
        abortSignal: options.abortSignal,
        experimental_repairText: repair,
        experimental_telemetry: buildTelemetry(options.telemetry, effectiveModel, budgetDecision),
      })

      const usage = extractUsageWithCost(response)
      logger.debug(
        { usage, requestedModel: options.model, model: effectiveModel },
        "AI generateObject completed with usage"
      )

      await maybeRecordUsage({
        context: options.context,
        functionId: options.telemetry?.functionId ?? "generateObject",
        modelString: effectiveModel,
        usage,
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
      const budgetDecision = await resolveBudgetPolicy({
        modelString: options.model,
        context: options.context,
        functionId: options.telemetry?.functionId ?? "embed",
      })
      const effectiveModel = budgetDecision.effectiveModel
      const model = getEmbeddingModel(effectiveModel)
      const response = await aiEmbed({
        model,
        value: options.value,
        abortSignal: options.abortSignal,
        // @ts-expect-error AI SDK telemetry types are stricter than needed; our buildTelemetry output is compatible at runtime
        experimental_telemetry: buildTelemetry(options.telemetry, effectiveModel, budgetDecision),
      })

      const usage = extractUsageWithCost(response)
      logger.debug({ usage, requestedModel: options.model, model: effectiveModel }, "AI embed completed with usage")

      await maybeRecordUsage({
        context: options.context,
        functionId: options.telemetry?.functionId ?? "embed",
        modelString: effectiveModel,
        usage,
        metadata: options.telemetry?.metadata as Record<string, unknown> | undefined,
      })

      return {
        value: response.embedding,
        response,
        usage,
      }
    },

    async embedMany(options) {
      const budgetDecision = await resolveBudgetPolicy({
        modelString: options.model,
        context: options.context,
        functionId: options.telemetry?.functionId ?? "embedMany",
      })
      const effectiveModel = budgetDecision.effectiveModel
      const model = getEmbeddingModel(effectiveModel)
      const response = await aiEmbedMany({
        model,
        values: options.values,
        abortSignal: options.abortSignal,
        // @ts-expect-error AI SDK telemetry types are stricter than needed; our buildTelemetry output is compatible at runtime
        experimental_telemetry: buildTelemetry(options.telemetry, effectiveModel, budgetDecision),
      })

      const usage = extractUsageWithCost(response)
      logger.debug(
        { usage, requestedModel: options.model, model: effectiveModel, count: options.values.length },
        "AI embedMany completed with usage"
      )

      await maybeRecordUsage({
        context: options.context,
        functionId: options.telemetry?.functionId ?? "embedMany",
        modelString: effectiveModel,
        usage,
        metadata: { ...options.telemetry?.metadata, count: options.values.length } as
          | Record<string, unknown>
          | undefined,
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
