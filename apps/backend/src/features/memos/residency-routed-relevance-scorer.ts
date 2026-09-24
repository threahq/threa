import { AISpendDeniedError, type DecisionsAvailability } from "@threahq/agent-runtime"
import type { AIResidencyPolicy } from "../ai-usage"
import { logger } from "../../lib/logger"
import type { RelevanceScorerLike } from "./relevance-scorer"
import type { RerankCandidate, RerankContext } from "./reranker"

/**
 * Picks the scoring path by the workspace's AI residency pin, the same way
 * `ResidencyRoutedMemoClassifier` picks the classification path.
 *
 * A pinned workspace is left unscored rather than routed to an inference model.
 * Scoring a whole candidate pool on every search is affordable only at the
 * decision model's price, so the pinned path is not a cheaper judgment — it is
 * no judgment, and the caller keeps fusion order. A spend denial is not a path
 * failure and is rethrown.
 */
export class ResidencyRoutedRelevanceScorer implements RelevanceScorerLike {
  private readonly residency: AIResidencyPolicy
  private readonly decisions: RelevanceScorerLike
  private readonly availability: DecisionsAvailability

  constructor(deps: {
    residency: AIResidencyPolicy
    decisions: RelevanceScorerLike
    availability: DecisionsAvailability
  }) {
    this.residency = deps.residency
    this.decisions = deps.decisions
    this.availability = deps.availability
  }

  async score(query: string, candidates: RerankCandidate[], context: RerankContext): Promise<number[] | null> {
    if ((await this.residency.isPinned(context.workspaceId)) || !this.availability.isAvailable) return null

    try {
      return await this.decisions.score(query, candidates, context)
    } catch (error) {
      if (error instanceof AISpendDeniedError) throw error
      this.availability.recordFailure(error)
      logger.warn({ error, workspaceId: context.workspaceId }, "Decision-model relevance scoring failed")
      return null
    }
  }
}
