import { Pool } from "pg"
import { SearchRepository, type ConversationSearchResult, type SearchResult, type ResolvedFilters } from "./repository"
import type { EmbeddingServiceLike, MemoExplorerResult, MemoExplorerSearchParams, RerankerLike } from "../memos"
import { buildSearchClusters, type SearchCluster } from "./clusters"
import { logger } from "../../lib/logger"
import type { FeatureFlagValue, SearchRefinement, StreamType } from "@threahq/types"
import {
  CONVERSATION_SEARCH_LIMIT,
  CONVERSATION_SEARCH_MAX_DISTANCE,
  hybridWeightsForQuery,
  MEMO_SEARCH_LIMIT,
  searchRankingForFlag,
  type SearchRanking,
  SEARCH_DEEP_CANDIDATE_POOL,
  SEARCH_RERANK_CANDIDATE_LIMIT,
  SEARCH_RERANK_SNIPPET_CHARS,
  SEARCH_RRF_K,
} from "./config"
import { E2eStreamsRepository } from "../e2e-streams"
import type { QueryExpanderLike } from "./query-expansion"
import type { SearchRefinerLike } from "./refine"

export type ArchiveStatus = "active" | "archived"

/**
 * Client-provided filters with pre-resolved IDs.
 * All lookups (username to ID, etc.) happen client-side.
 */
export interface SearchFilters {
  authorId?: string // Single author (from:@user)
  userIds?: string[] // Multiple users/personas, AND logic (with:@user or with:@persona)
  streamIds?: string[] // Stream IDs (in:#channel)
  streamTypes?: StreamType[] // Stream types, OR logic (type:scratchpad)
  archiveStatus?: ArchiveStatus[] // Archive status (is:archived, is:active)
  before?: Date // Exclusive (<)
  after?: Date // Inclusive (>=)
}

/**
 * Caller-resolved access boundary.
 * The caller resolves what the requester can see and passes it here.
 * This keeps SearchService auth-agnostic.
 */
export interface SearchPermissions {
  accessibleStreamIds: string[]
  /** The person searching; gates user-scoped memos to their owner. Absent for bots and agents. */
  userId?: string
}

export interface SearchParams {
  workspaceId: string
  permissions: SearchPermissions
  query: string
  phrases?: string[]
  filters?: SearchFilters
  limit?: number
  /** If true, use exact substring matching (ILIKE) instead of full-text search */
  exact?: boolean
  /** If true, skip embedding generation and use keyword-only search */
  skipEmbedding?: boolean
  /** Rewrite the query into variants, fuse, and rerank; costs two model calls. */
  deep?: boolean
  /** Refinements of the result list, oldest first; one model call over the clustered rows. */
  refine?: SearchRefinement[]
  /**
   * The requester's resolved `search` flag. "off" runs the pre-rework ranking,
   * ignores `deep` and returns no conversations. Required so a caller cannot
   * fall into either behaviour by omission (INV-11).
   */
  searchFlag: FeatureFlagValue<"search">
}

export interface SearchResponse {
  results: SearchResult[]
  /**
   * Whole conversations near the query, ordered by distance. Empty on the
   * exact, keyword-only and no-embedding paths: the leg is semantic only.
   */
  conversations: ConversationSearchResult[]
  /**
   * Number of streams in the requester's accessible set that were skipped
   * because they are E2E-encrypted. The server can't search their content;
   * the frontend uses this count to surface a "X encrypted streams not
   * searched here" indicator and run a parallel client-side search against
   * its local index.
   */
  excludedE2eStreamCount: number
}

export interface SearchClustersResponse extends SearchResponse {
  /**
   * Memos near the query, ranked. Empty on exact, keyword-only and legacy
   * searches, and when a filter memo search cannot honour is set.
   */
  memos: MemoExplorerResult[]
  /**
   * `results`, `conversations` and `memos` folded into one ranked list of
   * conversation rows; the user-facing shape of the search.
   */
  clusters: SearchCluster[]
  /**
   * What became of `params.refine`: `null` when none was asked for; `applied`
   * false when the model call failed and the lists are unrefined (INV-11);
   * `note` is the model's one-line account, null when it gave none.
   */
  refine: { applied: boolean; note: string | null } | null
}

export interface MemoSearchLike {
  search(params: MemoExplorerSearchParams): Promise<MemoExplorerResult[]>
}

export interface SearchServiceDependencies {
  pool: Pool
  embeddingService: EmbeddingServiceLike
  queryExpander: QueryExpanderLike
  reranker: RerankerLike
  memoSearch: MemoSearchLike
  refiner: SearchRefinerLike
}

const DEFAULT_LIMIT = 20

/**
 * Reciprocal rank fusion over per-query result lists: score(id) = Σ over
 * lists 1/(k + rank), rank 1-based position in that list. Keeps the
 * first-seen `SearchResult` object per id (its `rank` is overwritten with
 * the fused score) and sorts by score desc, then `createdAt` desc for ties.
 */
export function fuseRankedLists(lists: SearchResult[][], k: number): SearchResult[] {
  const scoreById = new Map<string, number>()
  const resultById = new Map<string, SearchResult>()

  for (const list of lists) {
    list.forEach((result, index) => {
      const rank = index + 1
      scoreById.set(result.id, (scoreById.get(result.id) ?? 0) + 1 / (k + rank))
      if (!resultById.has(result.id)) {
        resultById.set(result.id, result)
      }
    })
  }

  const fused = [...resultById.values()]
  for (const result of fused) {
    result.rank = scoreById.get(result.id) ?? 0
  }

  fused.sort((a, b) => {
    const scoreDiff = (scoreById.get(b.id) ?? 0) - (scoreById.get(a.id) ?? 0)
    if (scoreDiff !== 0) return scoreDiff
    return b.createdAt.getTime() - a.createdAt.getTime()
  })

  return fused
}

export class SearchService {
  private pool: Pool
  private embeddingService: EmbeddingServiceLike
  private queryExpander: QueryExpanderLike
  private reranker: RerankerLike
  private memoSearch: MemoSearchLike
  private refiner: SearchRefinerLike

  constructor(deps: SearchServiceDependencies) {
    this.pool = deps.pool
    this.embeddingService = deps.embeddingService
    this.queryExpander = deps.queryExpander
    this.reranker = deps.reranker
    this.memoSearch = deps.memoSearch
    this.refiner = deps.refiner
  }

  /**
   * Perform hybrid search combining full-text and semantic search.
   * Uses a single SQL query with RRF ranking.
   *
   * When exact=true, uses ILIKE for true substring matching instead of full-text search.
   * This is useful for error messages, IDs, or other literal text.
   *
   * When deep=true (and not exact/skipEmbedding, and the trimmed query is
   * non-empty), the query is rewritten into alternative phrasings, each
   * phrasing runs the same hybrid search, the result lists are fused by
   * reciprocal rank, and a fail-open LLM reranker reorders the top window.
   *
   * The caller resolves access boundaries and passes them via `permissions`.
   * This keeps SearchService auth-agnostic — it works for session auth, API keys, and agents.
   */
  async search(params: SearchParams): Promise<SearchResponse> {
    const { results, conversations, excludedE2eStreamCount } = await this.runLegs(params, { memos: false })
    return { results, conversations, excludedE2eStreamCount }
  }

  /**
   * The search page's shape: `search` plus the memo leg, folded into one
   * ranked list of conversation rows; only this entry point runs the memo leg.
   */
  async searchClusters(params: SearchParams): Promise<SearchClustersResponse> {
    const { streamIds, ...legs } = await this.runLegs(params, { memos: true })
    const clusters = await this.clusterResults({ workspaceId: params.workspaceId, streamIds, ...legs })
    // The refine belongs to the reworked ranking; under the pre-rework flag value it is ignored.
    const refines =
      searchRankingForFlag(params.searchFlag) === "improved"
        ? (params.refine?.filter((refine) => typeof refine !== "string" || refine.trim().length > 0) ?? [])
        : []
    if (refines.length === 0) return { ...legs, clusters, refine: null }
    if (clusters.length === 0) return { ...legs, clusters, refine: { applied: true, note: null } }

    const refined = await this.refiner.refine({
      query: params.query,
      refines,
      clusters,
      memos: legs.memos,
      context: { workspaceId: params.workspaceId, userId: params.permissions.userId },
    })
    if (!refined) return { ...legs, clusters, refine: { applied: false, note: null } }

    const kept = refined.keep.map((index) => clusters[index]!)
    // The flat list follows the refined row order; within a row the hits keep their rank (stable sort).
    const keptHitRow = new Map(kept.flatMap((cluster, row) => cluster.hits.map((hit) => [hit.id, row] as const)))
    const keptConversationIds = new Set(
      kept.flatMap((cluster) => (cluster.conversation ? [cluster.conversation.id] : []))
    )
    const keptMemoIds = new Set(kept.flatMap((cluster) => cluster.memoIds))
    return {
      results: legs.results
        .filter((result) => keptHitRow.has(result.id))
        .sort((a, b) => keptHitRow.get(a.id)! - keptHitRow.get(b.id)!),
      conversations: legs.conversations.filter((conversation) => keptConversationIds.has(conversation.id)),
      memos: legs.memos.filter((result) => keptMemoIds.has(result.memo.id)),
      excludedE2eStreamCount: legs.excludedE2eStreamCount,
      clusters: kept,
      refine: { applied: true, note: refined.note || null },
    }
  }

  private async runLegs(
    params: SearchParams,
    legs: { memos: boolean }
  ): Promise<Omit<SearchClustersResponse, "clusters" | "refine"> & { streamIds: string[] }> {
    const {
      workspaceId,
      permissions,
      query,
      phrases = [],
      filters = {},
      limit = DEFAULT_LIMIT,
      exact = false,
      skipEmbedding = false,
      searchFlag,
    } = params
    const ranking = searchRankingForFlag(searchFlag)
    const deep = ranking === "improved" && (params.deep ?? false)

    logger.debug({ query, phrases, filters, workspaceId, exact, deep, ranking }, "Search request")

    const candidateStreamIds = this.resolveStreamIds(permissions.accessibleStreamIds, filters)

    // Partition out E2E streams: the server can't read their ciphertext, so
    // we exclude them from the SQL search and report the count so the
    // frontend can surface the gap and run its own client-side search.
    const e2eStreamIds = await E2eStreamsRepository.filterE2eStreamIds(this.pool, workspaceId, candidateStreamIds)
    const excludedE2eStreamCount = e2eStreamIds.length
    const streamIds =
      excludedE2eStreamCount === 0
        ? candidateStreamIds
        : (() => {
            const e2eSet = new Set(e2eStreamIds)
            return candidateStreamIds.filter((id) => !e2eSet.has(id))
          })()

    if (streamIds.length === 0) {
      logger.debug({ workspaceId, excludedE2eStreamCount }, "No accessible plaintext streams")
      return { results: [], conversations: [], memos: [], excludedE2eStreamCount, streamIds: [] }
    }

    const repoFilters: ResolvedFilters = {
      authorId: filters.authorId,
      streamTypes: filters.streamTypes,
      before: filters.before,
      after: filters.after,
    }

    // For exact matching, skip embedding generation - use ILIKE directly (INV-30: single query, pass pool)
    if (exact) {
      const results = await SearchRepository.exactSearch(this.pool, {
        query,
        phrases,
        streamIds,
        filters: repoFilters,
        limit,
      })
      return { results, conversations: [], memos: [], excludedE2eStreamCount, streamIds }
    }

    // One query embedding serves the message leg, the conversation leg and
    // deep mode's original-query variant (INV-41: no connection held yet).
    const normalizedQuery = query.trim()
    let queryEmbedding: number[] = []
    if (!skipEmbedding && normalizedQuery) {
      try {
        queryEmbedding = await this.embeddingService.embed(normalizedQuery, { workspaceId, functionId: "search-query" })
      } catch (error) {
        logger.warn({ error }, "Failed to generate embedding, falling back to keyword-only search")
      }
    }

    const conversationLeg =
      ranking === "improved" && queryEmbedding.length > 0
        ? SearchRepository.conversationSearch(this.pool, {
            workspaceId,
            embedding: queryEmbedding,
            streamIds,
            filters: repoFilters,
            limit: CONVERSATION_SEARCH_LIMIT,
            maxDistance: CONVERSATION_SEARCH_MAX_DISTANCE,
          })
        : Promise.resolve([])

    const messageLeg =
      deep && queryEmbedding.length > 0
        ? this.deepSearch({ normalizedQuery, queryEmbedding, phrases, streamIds, repoFilters, limit, workspaceId })
        : this.singleQuerySearch({
            normalizedQuery,
            embedding: queryEmbedding,
            phrases,
            streamIds,
            repoFilters,
            limit,
            ranking,
          })

    // Memo search honours stream and date filters; with:/type:/status: already
    // narrowed `streamIds` (the frontend sends status: on every request), but
    // from: has no memo equivalent and would be silently ignored, so it skips the leg.
    // The leg runs `fast`: no model call on the default path, the query
    // embedding reused when the memo query is the same text. A refinement is the
    // one place a search waits on a model.
    const memoQuery = [normalizedQuery, ...phrases].join(" ").trim()
    const memoLeg =
      legs.memos && ranking === "improved" && memoQuery.length > 0 && filters.authorId === undefined
        ? this.memoSearch.search({
            workspaceId,
            permissions: { accessibleStreamIds: streamIds, userId: permissions.userId },
            query: memoQuery,
            filters: { before: filters.before, after: filters.after },
            limit: MEMO_SEARCH_LIMIT,
            mode: "fast",
            ...(memoQuery === normalizedQuery && queryEmbedding.length > 0 ? { embedding: queryEmbedding } : {}),
          })
        : Promise.resolve([])

    const [results, conversations, memos] = await Promise.all([messageLeg, conversationLeg, memoLeg])
    return { results, conversations, memos, excludedE2eStreamCount, streamIds }
  }

  /**
   * Joins the message hits and memo sources to their conversations, fetches
   * the memo sources the message leg did not already return, and folds it
   * all into rows. Two statements on the pool (INV-30), both restricted to
   * the streams the requester may read (INV-62).
   */
  private async clusterResults(args: {
    workspaceId: string
    streamIds: string[]
    results: SearchResult[]
    conversations: ConversationSearchResult[]
    memos: MemoExplorerResult[]
  }): Promise<SearchCluster[]> {
    const { workspaceId, streamIds, results, conversations, memos } = args
    const resultIds = new Set(results.map((r) => r.id))
    const sourceIds = new Set(memos.flatMap((m) => m.memo.sourceMessageIds))
    const [conversationByMessageId, sourceMessages] = await Promise.all([
      SearchRepository.conversationsForMessages(this.pool, {
        workspaceId,
        messageIds: [...new Set([...resultIds, ...sourceIds])],
        streamIds,
      }),
      SearchRepository.messagesByIds(this.pool, {
        ids: [...sourceIds].filter((id) => !resultIds.has(id)),
        streamIds,
      }),
    ])
    return buildSearchClusters({
      results,
      conversations,
      memos,
      conversationByMessageId,
      sourceMessages,
      k: SEARCH_RRF_K,
    })
  }

  private async singleQuerySearch(params: {
    normalizedQuery: string
    embedding: number[]
    phrases: string[]
    streamIds: string[]
    repoFilters: ResolvedFilters
    limit: number
    ranking: SearchRanking
  }): Promise<SearchResult[]> {
    const { normalizedQuery, embedding, phrases, streamIds, repoFilters, limit, ranking } = params

    // INV-30: each branch issues a single query, pass pool directly
    const hasQuery = normalizedQuery.length > 0
    const hasEmbedding = embedding.length > 0

    if (!hasQuery || !hasEmbedding) {
      return SearchRepository.fullTextSearch(this.pool, {
        query: normalizedQuery,
        phrases,
        streamIds,
        filters: repoFilters,
        limit,
        ranking,
      })
    }

    return SearchRepository.hybridSearch(this.pool, {
      query: normalizedQuery,
      phrases,
      embedding,
      streamIds,
      filters: repoFilters,
      limit,
      ranking,
      ...hybridWeightsForQuery(normalizedQuery, ranking),
    })
  }

  private async deepSearch(args: {
    normalizedQuery: string
    queryEmbedding: number[]
    phrases: string[]
    streamIds: string[]
    repoFilters: ResolvedFilters
    limit: number
    workspaceId: string
  }): Promise<SearchResult[]> {
    const { normalizedQuery, queryEmbedding, phrases, streamIds, repoFilters, limit, workspaceId } = args

    const variants = await this.queryExpander.expand(normalizedQuery, { workspaceId })
    const queries = [normalizedQuery, ...variants]

    let embeddings: number[][]
    try {
      const variantEmbeddings =
        variants.length === 0
          ? []
          : await this.embeddingService.embedBatch(variants, { workspaceId, functionId: "search-query" })
      embeddings = [queryEmbedding, ...variantEmbeddings]
    } catch (error) {
      logger.warn({ error, workspaceId }, "Deep search embedding batch failed; falling back to single-query search")
      return this.singleQuerySearch({
        normalizedQuery,
        embedding: queryEmbedding,
        phrases,
        streamIds,
        repoFilters,
        limit,
        ranking: "improved",
      })
    }

    // INV-30: one statement per variant on the pool; concurrent is fine.
    const lists = await Promise.all(
      queries.map((q, i) =>
        SearchRepository.hybridSearch(this.pool, {
          query: q,
          phrases,
          embedding: embeddings[i],
          streamIds,
          filters: repoFilters,
          limit: SEARCH_DEEP_CANDIDATE_POOL,
          ranking: "improved",
          ...hybridWeightsForQuery(q, "improved"),
        })
      )
    )

    const fused = fuseRankedLists(lists, SEARCH_RRF_K)
    const head = fused.slice(0, SEARCH_RERANK_CANDIDATE_LIMIT)
    const tail = fused.slice(SEARCH_RERANK_CANDIDATE_LIMIT)

    let ordered = head
    if (head.length > 1) {
      const order = await this.reranker.rerank(
        normalizedQuery,
        head.map((r) => ({ abstract: r.content.slice(0, SEARCH_RERANK_SNIPPET_CHARS) })),
        { workspaceId }
      )
      ordered = order.map((i) => head[i])
    }

    logger.debug(
      { workspaceId, variantCount: variants.length, candidateCount: fused.length },
      "Deep search fusion complete"
    )

    return [...ordered, ...tail].slice(0, limit)
  }

  /**
   * Intersect caller-provided accessible streams with user-requested stream filter.
   * If the user doesn't filter by stream, use all accessible streams.
   */
  private resolveStreamIds(accessibleStreamIds: string[], filters: SearchFilters): string[] {
    if (filters.streamIds && filters.streamIds.length > 0) {
      const accessibleSet = new Set(accessibleStreamIds)
      return [...new Set(filters.streamIds)].filter((id) => accessibleSet.has(id))
    }
    return accessibleStreamIds
  }
}
