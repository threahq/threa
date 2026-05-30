import type { AI, CostContext } from "@threa/agent-runtime"
import { runGeneralResearch, type AgentTool, type GeneralResearchResult } from "../runtime"
import { COMPONENT_PATHS, type ConfigResolver, type GeneralResearcherConfig } from "../../../lib/ai/config-resolver"

export type { GeneralResearchResult, GeneralResearchSubstep } from "@threa/agent-runtime"

export interface GeneralResearchInput {
  workspaceId: string
  /** The question delegated by the persona. */
  query: string
  /** Optional compact conversation context to ground the research. */
  conversationContext?: string
  /**
   * The tools the sub-agent may drive. Built by the persona layer via
   * `buildToolSet` with the research tool policy — web, URL reads, workspace
   * search primitives, and connected integrations. Excludes workspace_research
   * and send_message.
   */
  tools: AgentTool[]
  /** Cost context forwarded to every inner AI call for usage attribution. */
  costContext: CostContext
  /** Cooperative cancellation from the session abort registry (user stop). */
  signal: AbortSignal
  /** Absolute wall-clock deadline (ms epoch) after which we return partial. */
  deadlineAt: number
  /** Live phase updates surfaced on the persona's research trace step. */
  onSubstep: (text: string) => void
}

export interface GeneralResearcherDeps {
  ai: AI
  configResolver: ConfigResolver
}

/**
 * Backend adapter over the shared {@link runGeneralResearch} loop.
 *
 * The runtime-agnostic research loop lives in `@threa/agent-runtime` (so the
 * enclave can run the same code next to decrypted plaintext); this class is the
 * backend's binding: it resolves the overridable model/temperature/iterations
 * through the ConfigResolver, materialises the model + telemetry off the full
 * production `AI`, and forwards everything to the shared loop. No behavior of its
 * own beyond that wiring.
 */
export class GeneralResearcher {
  constructor(private readonly deps: GeneralResearcherDeps) {}

  async research(input: GeneralResearchInput): Promise<GeneralResearchResult> {
    const config = await this.deps.configResolver.resolve<GeneralResearcherConfig>(COMPONENT_PATHS.GENERAL_RESEARCHER)
    const modelId = config.modelId
    const parsed = this.deps.ai.parseModel(modelId)

    return runGeneralResearch(
      {
        ai: this.deps.ai,
        model: this.deps.ai.getLanguageModel(modelId),
        modelString: modelId,
        temperature: config.temperature,
        maxIterations: config.maxIterations,
        telemetry: {
          functionId: "general-research-loop",
          metadata: {
            model_id: parsed.modelId,
            model_provider: parsed.modelProvider,
            model_name: parsed.modelName,
          },
        },
      },
      {
        workspaceId: input.workspaceId,
        query: input.query,
        conversationContext: input.conversationContext,
        tools: input.tools,
        costContext: input.costContext,
        signal: input.signal,
        deadlineAt: input.deadlineAt,
        onSubstep: input.onSubstep,
      }
    )
  }
}
