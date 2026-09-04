import { Pool } from "pg"
import { SearchRepository, type SearchResult, type ResolvedFilters } from "./repository"
import type { EmbeddingServiceLike, RerankerLike } from "../memos"
import { logger } from "../../lib/logger"
import type { StreamType } from "@threa/types"
import {
  hybridWeightsForQuery,
  SEARCH_DEEP_CANDIDATE_POOL,
  SEARCH_RERANK_CANDIDATE_LIMIT,
  SEARCH_RERANK_SNIPPET_CHARS,
  SEARCH_RRF_K,
} from "./config"
import { E2eStreamsRepository } from "../e2e-streams"
import type { QueryExpanderLike } from "./query-expansion"

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
}

export interface SearchResponse {
  results: SearchResult[]
  /**
   * Number of streams in the requester's accessible set that were skipped
   * because they are E2E-encrypted. The server can't search their content;
   * the frontend uses this count to surface a "X encrypted streams not
   * searched here" indicator and run a parallel client-side search against
   * its local index.
   */
  excludedE2eStreamCount: number
}

export interface SearchServiceDependencies {
  pool: Pool
  embeddingService: EmbeddingServiceLike
  queryExpander: QueryExpanderLike
  reranker: RerankerLike
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

  constructor(deps: SearchServiceDependencies) {
    this.pool = deps.pool
    this.embeddingService = deps.embeddingService
    this.queryExpander = deps.queryExpander
    this.reranker = deps.reranker
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
    const {
      workspaceId,
      permissions,
      query,
      phrases = [],
      filters = {},
      limit = DEFAULT_LIMIT,
      exact = false,
      skipEmbedding = false,
      deep = false,
    } = params

    logger.debug({ query, phrases, filters, workspaceId, exact, deep }, "Search request")

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
      return { results: [], excludedE2eStreamCount }
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
      return { results, excludedE2eStreamCount }
    }

    const normalizedQuery = query.trim()
    if (deep && !skipEmbedding && normalizedQuery) {
      const results = await this.deepSearch({
        normalizedQuery,
        phrases,
        streamIds,
        repoFilters,
        limit,
        workspaceId,
      })
      return { results, excludedE2eStreamCount }
    }

    const results = await this.singleQuerySearch({
      query,
      phrases,
      streamIds,
      repoFilters,
      limit,
      skipEmbedding,
      workspaceId,
    })
    return { results, excludedE2eStreamCount }
  }

  /**
   * Non-deep search: embed the query, then a single full-text or hybrid
   * search. Factored out of `search` so deep mode can fall back to exactly
   * this path when its embedding batch fails.
   */
  private async singleQuerySearch(params: {
    query: string
    phrases: string[]
    streamIds: string[]
    repoFilters: ResolvedFilters
    limit: number
    skipEmbedding: boolean
    workspaceId: string
  }): Promise<SearchResult[]> {
    const { query, phrases, streamIds, repoFilters, limit, skipEmbedding, workspaceId } = params

    // Generate embedding for search query (do this before DB connection - INV-41)
    let embedding: number[] = []
    if (!skipEmbedding && query.trim()) {
      try {
        embedding = await this.embeddingService.embed(query, { workspaceId, functionId: "search-query" })
      } catch (error) {
        logger.warn({ error }, "Failed to generate embedding, falling back to keyword-only search")
      }
    }

    // INV-30: each branch issues a single query, pass pool directly
    const normalizedQuery = query.trim()
    const hasQuery = normalizedQuery.length > 0
    const hasEmbedding = embedding.length > 0

    if (!hasQuery || !hasEmbedding) {
      return SearchRepository.fullTextSearch(this.pool, {
        query: normalizedQuery,
        phrases,
        streamIds,
        filters: repoFilters,
        limit,
      })
    }

    return SearchRepository.hybridSearch(this.pool, {
      query: normalizedQuery,
      phrases,
      embedding,
      streamIds,
      filters: repoFilters,
      limit,
      ...hybridWeightsForQuery(normalizedQuery),
    })
  }

  /**
   * Deep search: rewrite the query into variants, run hybrid search per
   * variant, fuse by reciprocal rank, and rerank the top window.
   */
  private async deepSearch(args: {
    normalizedQuery: string
    phrases: string[]
    streamIds: string[]
    repoFilters: ResolvedFilters
    limit: number
    workspaceId: string
  }): Promise<SearchResult[]> {
    const { normalizedQuery, phrases, streamIds, repoFilters, limit, workspaceId } = args

    const variants = await this.queryExpander.expand(normalizedQuery, { workspaceId })
    const queries = [normalizedQuery, ...variants]

    let embeddings: number[][]
    try {
      embeddings = await this.embeddingService.embedBatch(queries, { workspaceId, functionId: "search-query" })
    } catch (error) {
      logger.warn({ error, workspaceId }, "Deep search embedding batch failed; falling back to single-query search")
      return this.singleQuerySearch({
        query: normalizedQuery,
        phrases,
        streamIds,
        repoFilters,
        limit,
        skipEmbedding: false,
        workspaceId,
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
          ...hybridWeightsForQuery(q),
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
