import { randomUUID } from "node:crypto"
import type { CostRecorder, ModelRegistry, UsageWithCost } from "@threahq/agent-runtime"
import type { AnalyticsReporter } from "@threahq/backend-common"

type RecordUsageParams = Parameters<CostRecorder["recordUsage"]>[0]

function generationProperties(params: RecordUsageParams, isEmbedding: boolean): Record<string, unknown> {
  const usage: UsageWithCost = params.usage
  return {
    // PostHog requires a trace id; nothing here spans several calls, so each
    // generation is its own trace and sessionId does the grouping instead.
    $ai_trace_id: randomUUID(),
    $ai_span_name: params.functionId,
    $ai_model: params.model,
    $ai_provider: params.provider,
    $ai_input_tokens: usage.promptTokens ?? 0,
    ...(isEmbedding ? {} : { $ai_output_tokens: usage.completionTokens ?? 0 }),
    ...(usage.cachedPromptTokens === undefined ? {} : { $ai_cache_read_input_tokens: usage.cachedPromptTokens }),
    ...(usage.cost === undefined ? {} : { $ai_total_cost_usd: usage.cost }),
    ...(params.latencyMs === undefined ? {} : { $ai_latency: params.latencyMs / 1000 }),
    ...(params.sessionId === undefined ? {} : { $ai_session_id: params.sessionId }),
    ai_origin: params.origin,
    // The distinct id is a workspace, not a person, and must not become one.
    $process_person_profile: false,
  }
}

/**
 * Reports each AI call to PostHog on the way to the real cost recorder, so both
 * see exactly the calls `createAI` makes. Prompts, completions and telemetry
 * metadata are deliberately absent: PostHog gets the model, the token counts,
 * the cost and the latency, never the content or who asked for it. Attribution
 * is the workspace group, so no person profile is created and no user consent
 * is implicated.
 */
export class AnalyticsCostRecorder implements CostRecorder {
  constructor(
    private readonly inner: CostRecorder,
    private readonly reporter: AnalyticsReporter,
    private readonly modelRegistry: ModelRegistry
  ) {}

  async recordUsage(params: RecordUsageParams): Promise<void> {
    const isEmbedding = this.modelRegistry.supportsOutputModality(`${params.provider}:${params.model}`, "embedding")
    this.reporter.captureEvent({
      distinctId: `workspace:${params.workspaceId}`,
      event: isEmbedding ? "$ai_embedding" : "$ai_generation",
      properties: generationProperties(params, isEmbedding),
      groups: { workspace: params.workspaceId },
    })
    await this.inner.recordUsage(params)
  }
}
