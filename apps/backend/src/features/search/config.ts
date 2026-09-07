import { z } from "zod"
import type { FeatureFlagValue } from "@threahq/types"
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

/**
 * Which message ranking a search runs. `legacy` is the pre-rework behaviour
 * behind the `search` feature flag's "off" value: AND-joined `websearch_to_tsquery`
 * terms, fixed fusion weights and a semantic distance gate. `improved` is the
 * flag's "on" value.
 */
export type SearchRanking = "legacy" | "improved"

export function searchRankingForFlag(searchFlag: FeatureFlagValue<"search">): SearchRanking {
  return searchFlag === "on" ? "improved" : "legacy"
}

const LEGACY_HYBRID_WEIGHTS = { keywordWeight: 0.6, semanticWeight: 0.4 }

/** Max cosine distance for a semantic message hit under legacy ranking. */
export const LEGACY_SEMANTIC_DISTANCE_THRESHOLD = 0.8

export function hybridWeightsForQuery(
  query: string,
  ranking: SearchRanking
): { keywordWeight: number; semanticWeight: number } {
  if (ranking === "legacy") return LEGACY_HYBRID_WEIGHTS
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

export const SEARCH_REFINE_MODEL_ID = "openrouter:openai/gpt-5.6-luna"
export const SEARCH_REFINE_TEMPERATURE = 0
/** Longer than expansion: the prompt carries every row of the list, and the answer is a ranked subset of it. */
export const SEARCH_REFINE_TIMEOUT_MS = 8000
/** Content chars per hit shown to the refining model. */
export const SEARCH_REFINE_SNIPPET_CHARS = 300
/** Hits per row shown to the refining model; the rest of a busy conversation adds little beyond its title. */
export const SEARCH_REFINE_HITS_PER_ROW = 3

export const searchRefineSchema = z.object({
  keep: z.array(z.number().int()),
  note: z.string(),
})

export const SEARCH_REFINE_SYSTEM_PROMPT = `You are refining a list of search results from a chat workspace. The user searched for a query and then gave one or more refining instructions in plain language, such as "only decisions", "drop the ones about billing", "newest first" or "where Martin agreed". Every instruction applies.

The rows arrive numbered. A row is a conversation (its title, the messages that matched inside it, and any memos of extracted knowledge attached to it) or a single message.

An instruction may name a row instead of describing it. "More like row [2]" means rank the rows that resemble row 2's messages higher and keep row 2 itself. "Drop row [2]" means remove row 2, and any row that is clearly about the same topic. When such an instruction names a conversation that is not in the list, apply it to the rows that are clearly about that conversation and otherwise leave the list as it is.

Return "keep": the numbers of the rows to show, best match first. Drop a row only when an instruction excludes it or asks for something the row clearly is not. Reorder when an instruction asks for an order or a priority; otherwise keep the given order. Never invent row numbers.

Return "note": one short sentence saying what you kept, dropped or reordered, in the language of the instructions. Never answer the query itself.`

/** Conversation hits shown above message results; a whole discussion per card, so three is a lot. */
export const CONVERSATION_SEARCH_LIMIT = 3

/**
 * Cosine distance ceiling for a conversation hit. text-embedding-3-small puts
 * paraphrases around 0.3–0.5 and unrelated text above 0.8; without a gate every
 * query would surface its three nearest conversations, related or not.
 */
export const CONVERSATION_SEARCH_MAX_DISTANCE = 0.75

/** Memo hits folded into the cluster list; matches the memo card count the search page showed before clusters. */
export const MEMO_SEARCH_LIMIT = 3
