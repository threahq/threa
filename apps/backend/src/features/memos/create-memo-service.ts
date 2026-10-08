import type { AI, DecisionsAvailability } from "@threahq/agent-runtime"
import type { AnalyticsReporter } from "@threahq/backend-common"
import type { Pool } from "pg"
import type { ConfigResolver } from "../../lib/ai/config-resolver"
import type { MessageFormatter } from "../../lib/ai/message-formatter"
import type { AIResidencyPolicy } from "../ai-usage"
import { MemoClassifier } from "./classifier"
import { DecisionsMemoClassifier } from "./decisions-classifier"
import type { EmbeddingServiceLike } from "./embedding-service"
import { Memorizer } from "./memorizer"
import { ResidencyRoutedMemoClassifier } from "./residency-routed-classifier"
import { MemoService, type SuggestionCollectorLike } from "./service"

export function createMemoService(deps: {
  pool: Pool
  ai: AI
  configResolver: ConfigResolver
  messageFormatter: MessageFormatter
  aiResidency: AIResidencyPolicy
  decisionsAvailability: DecisionsAvailability
  embeddingService: EmbeddingServiceLike
  analyticsReporter: AnalyticsReporter
  suggestionCollector?: SuggestionCollectorLike
  now?: () => Date
}): MemoService {
  return new MemoService({
    pool: deps.pool,
    analyticsReporter: deps.analyticsReporter,
    classifier: new ResidencyRoutedMemoClassifier({
      residency: deps.aiResidency,
      decisions: new DecisionsMemoClassifier(deps.ai),
      inference: new MemoClassifier(deps.ai, deps.configResolver, deps.messageFormatter),
      availability: deps.decisionsAvailability,
    }),
    memorizer: new Memorizer(deps.ai, deps.configResolver, deps.messageFormatter),
    embeddingService: deps.embeddingService,
    messageFormatter: deps.messageFormatter,
    suggestionCollector: deps.suggestionCollector,
    now: deps.now,
  })
}
