import { z } from "zod"
import { classifyMemoQueryIntent, type MemoQueryIntent } from "../memos"

/**
 * Fusion weights for message hybrid search RRF, keyed by query intent.
 * Short or digit-bearing queries are lookups where exact terms matter most
 * (temporal, entity); longer queries are descriptions where meaning matters
 * more (general).
 */
const HYBRID_WEIGHTS_BY_INTENT: Record<MemoQueryIntent, { keywordWeight: number; semanticWeight: number }> = {
  temporal: { keywordWeight: 0.7, semanticWeight: 0.3 },
  entity: { keywordWeight: 0.6, semanticWeight: 0.4 },
  general: { keywordWeight: 0.4, semanticWeight: 0.6 },
}

export function hybridWeightsForQuery(query: string): { keywordWeight: number; semanticWeight: number } {
  const { intent } = classifyMemoQueryIntent(query)
  return HYBRID_WEIGHTS_BY_INTENT[intent]
}

export const SEARCH_EXPANSION_MODEL_ID = "openrouter:openai/gpt-5.6-luna"
export const SEARCH_EXPANSION_TEMPERATURE = 0
export const SEARCH_EXPANSION_TIMEOUT_MS = 4000
export const SEARCH_EXPANSION_MAX_VARIANTS = 3

/** Rows pulled per query variant before fusion; the fused list is trimmed to the caller's limit after rerank. */
export const SEARCH_DEEP_CANDIDATE_POOL = 60

/** Top-K window handed to the reranker; the un-reranked tail is appended (recall protection). */
export const SEARCH_RERANK_CANDIDATE_LIMIT = 30

/** Content chars per candidate shown to the reranker. */
export const SEARCH_RERANK_SNIPPET_CHARS = 600

export const SEARCH_RRF_K = 60

export const searchExpansionSchema = z.object({
  variants: z.array(z.string()).max(SEARCH_EXPANSION_MAX_VARIANTS),
})

export const SEARCH_EXPANSION_SYSTEM_PROMPT = `You are helping search a chat workspace. The user's query is written from memory and may not match the literal wording of the messages they are looking for.

Return up to ${SEARCH_EXPANSION_MAX_VARIANTS} alternative phrasings of the query that people might actually have used when writing those messages: concrete wording, likely synonyms, named things the query only describes. One variant may be a short keyword form. Write each variant in the same language as the query — never assume English.

Never answer the query. Never add facts, entities, or assumptions not implied by the query itself. Return only the variants array.`

/** Conversation hits shown above message results; a whole discussion per card, so three is a lot. */
export const CONVERSATION_SEARCH_LIMIT = 3

/**
 * Cosine distance ceiling for a conversation hit. text-embedding-3-small puts
 * paraphrases around 0.3–0.5 and unrelated text above 0.8; without a gate every
 * query would surface its three nearest conversations, related or not.
 */
export const CONVERSATION_SEARCH_MAX_DISTANCE = 0.75
