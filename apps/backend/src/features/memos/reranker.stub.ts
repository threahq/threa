import type { RerankerLike, RerankCandidate, RerankContext } from "./reranker"

/**
 * Stub reranker for tests / `useStubAI`: identity order (no model call),
 * which is exactly the production fail-open behaviour.
 */
export class StubReranker implements RerankerLike {
  async rerank(_query: string, candidates: RerankCandidate[], _context: RerankContext): Promise<number[]> {
    return Array.from({ length: candidates.length }, (_, i) => i)
  }
}
