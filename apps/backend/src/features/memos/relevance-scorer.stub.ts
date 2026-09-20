import type { RelevanceScorerLike } from "./relevance-scorer"
import type { RerankCandidate, RerankContext } from "./reranker"

/**
 * Stub relevance scorer for tests / `useStubAI`: no judgment, which is exactly
 * the production behaviour when the decision model is unreachable — the caller
 * keeps fusion order.
 */
export class StubRelevanceScorer implements RelevanceScorerLike {
  async score(_query: string, _candidates: RerankCandidate[], _context: RerankContext): Promise<number[] | null> {
    return null
  }
}
