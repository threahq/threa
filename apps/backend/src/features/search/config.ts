import { classifyMemoQueryIntent, type MemoQueryIntent } from "../memos"

/**
 * Fusion weights for message hybrid search RRF, keyed by query intent.
 * Short or digit-bearing queries are lookups where exact terms matter most
 * (temporal, entity); longer queries are descriptions where meaning matters
 * more (general).
 */
export const HYBRID_WEIGHTS_BY_INTENT: Record<MemoQueryIntent, { keywordWeight: number; semanticWeight: number }> = {
  temporal: { keywordWeight: 0.7, semanticWeight: 0.3 },
  entity: { keywordWeight: 0.6, semanticWeight: 0.4 },
  general: { keywordWeight: 0.4, semanticWeight: 0.6 },
}

export function hybridWeightsForQuery(query: string): { keywordWeight: number; semanticWeight: number } {
  const { intent } = classifyMemoQueryIntent(query)
  return HYBRID_WEIGHTS_BY_INTENT[intent]
}
