import type { Querier } from "../../db"
import { sql, composeSql } from "../../db"
import { DM_PARTICIPANT_COUNT, Visibilities, type AuthorType, type JSONContent, type StreamType } from "@threa/types"
import { parseArchiveStatusFilter, type ArchiveStatus } from "../../lib/sql-filters"
import { streamAccessPredicateSql } from "../streams"
import { REPLY_COUNT_SUBQUERY } from "../messaging"
import type { AgentAccessSpec } from "../agents"

export interface GetAccessibleStreamsParams {
  workspaceId: string
  userId: string
  userIds?: string[] // Can mix user IDs and persona IDs; prefix distinguishes
  streamTypes?: StreamType[]
  archiveStatus?: ArchiveStatus[] // ["active"] = active only, ["archived"] = archived only, ["active", "archived"] = all
}

export interface SearchResult {
  id: string
  streamId: string
  content: string
  /**
   * Canonical content, retained internally so slot pointers can be collected
   * from search results (D5). Never serialized to the public wire — the search
   * response exposes markdown `content` only (INV-58). Always populated on rows
   * returned by this repository; optional only because out-of-feature consumers
   * (the researcher's surrounding-context projection) build partial shapes.
   */
  contentJson?: JSONContent
  authorId: string
  authorType: AuthorType
  sequence: bigint
  replyCount: number
  metadata: Record<string, string>
  editedAt: Date | null
  createdAt: Date
  rank: number
}

interface SearchResultRow {
  id: string
  stream_id: string
  content_markdown: string
  content_json: JSONContent
  author_id: string
  author_type: string
  sequence: string
  reply_count: number
  metadata: Record<string, string>
  edited_at: Date | null
  created_at: Date
  rank: number
}

function mapRowToSearchResult(row: SearchResultRow): SearchResult {
  return {
    id: row.id,
    streamId: row.stream_id,
    content: row.content_markdown,
    contentJson: row.content_json,
    authorId: row.author_id,
    authorType: row.author_type as AuthorType,
    sequence: BigInt(row.sequence),
    replyCount: row.reply_count,
    metadata: row.metadata ?? {},
    editedAt: row.edited_at,
    createdAt: row.created_at,
    rank: row.rank,
  }
}

function getValidatedUserIntersectionUserIds(userIds: string[]): [string, string] {
  const uniqueUserIds = [...new Set(userIds)]
  if (userIds.length !== DM_PARTICIPANT_COUNT || uniqueUserIds.length !== DM_PARTICIPANT_COUNT) {
    throw new Error(`user_intersection access spec requires exactly ${DM_PARTICIPANT_COUNT} distinct users`)
  }

  return [uniqueUserIds[0]!, uniqueUserIds[1]!]
}

/**
 * Resolved filters with validated/looked-up values.
 * All user-provided strings have been resolved to safe IDs or validated values.
 */
export interface ResolvedFilters {
  authorId?: string // Single author (from:@user)
  streamTypes?: StreamType[] // Stream types, OR logic (is:type)
  before?: Date // Exclusive (<)
  after?: Date // Inclusive (>=)
}

export interface FullTextSearchParams {
  query: string
  phrases?: string[]
  streamIds: string[]
  filters: ResolvedFilters
  limit: number
}

export interface HybridSearchParams {
  query: string
  phrases?: string[]
  embedding: number[]
  streamIds: string[]
  filters: ResolvedFilters
  limit: number
  keywordWeight?: number
  semanticWeight?: number
  k?: number
  /** Max L2 distance for semantic results; only messages with distance < this are included. */
  semanticDistanceThreshold: number
}

function escapeLike(value: string): string {
  return value.replace(/[%_\\]/g, "\\$&")
}

function phrasePredicatesSql(phrases: string[]) {
  let predicates = composeSql``
  for (const phrase of phrases) {
    predicates = composeSql`${predicates} AND m.content_markdown ILIKE '%' || ${escapeLike(phrase)} || '%'`
  }
  return predicates
}

export const SearchRepository = {
  /**
   * Get stream IDs that a user can access, optionally filtered by required participants.
   * Combines access control + participant filtering in ONE query.
   *
   * Access rules:
   * - User is in the stream, OR
   * - Stream is public, OR
   * - For threads: user can access the root stream (member OR root is public)
   *
   * Participant filtering (AND logic):
   * - If userIds provided, stream must have ALL specified participants
   * - Participants can be users (stream_members) or personas (stream_persona_participants)
   * - Threads carry no member rows (INV-62), so a thread qualifies when its
   *   root stream has all specified participants
   *
   * Archive status:
   * - ["active"] (default) → only non-archived streams
   * - ["archived"] → only archived streams
   * - ["active", "archived"] → all streams
   */
  async getAccessibleStreamsWithMembers(db: Querier, params: GetAccessibleStreamsParams): Promise<string[]> {
    const { workspaceId, userId, userIds, streamTypes, archiveStatus } = params
    const hasParticipantFilter = userIds && userIds.length > 0
    const hasTypeFilter = streamTypes && streamTypes.length > 0

    const { includeActive, includeArchived, filterAll } = parseArchiveStatusFilter(archiveStatus)

    if (!hasParticipantFilter) {
      const result = await db.query<{ id: string }>(composeSql`
        SELECT s.id
        FROM streams s
        WHERE s.workspace_id = ${workspaceId}
          AND ${streamAccessPredicateSql(workspaceId, userId, "s.id")}
          AND (${!hasTypeFilter} OR s.type = ANY(${streamTypes ?? []}))
          AND (${filterAll} OR (${includeArchived} AND s.archived_at IS NOT NULL) OR (${!includeArchived} AND s.archived_at IS NULL))
      `)
      return result.rows.map((r) => r.id)
    }

    // With participant filter: combined query using UNION for users + personas
    const result = await db.query<{ id: string }>(composeSql`
      WITH accessible AS (
        SELECT s.id
        FROM streams s
        WHERE s.workspace_id = ${workspaceId}
          AND ${streamAccessPredicateSql(workspaceId, userId, "s.id")}
          AND (${!hasTypeFilter} OR s.type = ANY(${streamTypes ?? []}))
          AND (${filterAll} OR (${includeArchived} AND s.archived_at IS NOT NULL) OR (${!includeArchived} AND s.archived_at IS NULL))
      ),
      member_streams AS (
        SELECT stream_id
        FROM (
          SELECT stream_id, member_id
          FROM stream_members
          WHERE member_id = ANY(${userIds})
          UNION ALL
          SELECT stream_id, persona_id AS member_id
          FROM stream_persona_participants
          WHERE persona_id = ANY(${userIds})
        ) t
        GROUP BY stream_id
        HAVING COUNT(DISTINCT member_id) = ${userIds.length}
      )
      SELECT DISTINCT a.id
      FROM accessible a
      JOIN streams st ON st.id = a.id
      JOIN member_streams m ON m.stream_id = a.id OR m.stream_id = st.root_stream_id
    `)

    return result.rows.map((r) => r.id)
  },

  /**
   * Full-text search using PostgreSQL tsvector with websearch syntax.
   * Supports quoted phrases for exact matching: "chicken wingz"
   * Results are ranked by ts_rank.
   * If query is empty, returns recent messages matching filters.
   */
  async fullTextSearch(db: Querier, params: FullTextSearchParams): Promise<SearchResult[]> {
    const { query, phrases = [], streamIds, filters, limit } = params

    if (streamIds.length === 0) {
      return []
    }

    if (!query.trim()) {
      const result = await db.query<SearchResultRow>(composeSql`
        SELECT
          m.id,
          m.stream_id,
          m.content_markdown,
          m.content_json,
          m.author_id,
          m.author_type,
          m.sequence,
          ${sql`${sql.raw(REPLY_COUNT_SUBQUERY("m"))}`},
          m.metadata,
          m.edited_at,
          m.created_at,
          0 as rank
        FROM messages m
        JOIN streams s ON m.stream_id = s.id
        WHERE m.stream_id = ANY(${streamIds})
          AND m.deleted_at IS NULL
          ${phrasePredicatesSql(phrases)}
          AND (${filters.authorId === undefined} OR m.author_id = ${filters.authorId ?? ""})
          AND (${filters.streamTypes === undefined || filters.streamTypes.length === 0} OR s.type = ANY(${filters.streamTypes ?? []}))
          AND (${filters.before === undefined} OR m.created_at < ${filters.before ?? new Date()})
          AND (${filters.after === undefined} OR m.created_at >= ${filters.after ?? new Date(0)})
        ORDER BY m.created_at DESC
        LIMIT ${limit}
      `)
      return result.rows.map(mapRowToSearchResult)
    }

    const result = await db.query<SearchResultRow>(composeSql`
      SELECT
        m.id,
        m.stream_id,
        m.content_markdown,
        m.content_json,
        m.author_id,
        m.author_type,
        m.sequence,
        ${sql`${sql.raw(REPLY_COUNT_SUBQUERY("m"))}`},
        m.metadata,
        m.edited_at,
        m.created_at,
        ts_rank(m.search_vector, websearch_to_tsquery('english', ${query})) as rank
      FROM messages m
      JOIN streams s ON m.stream_id = s.id
      WHERE m.stream_id = ANY(${streamIds})
        AND m.deleted_at IS NULL
        AND m.search_vector @@ websearch_to_tsquery('english', ${query})
        ${phrasePredicatesSql(phrases)}
        AND (${filters.authorId === undefined} OR m.author_id = ${filters.authorId ?? ""})
        AND (${filters.streamTypes === undefined || filters.streamTypes.length === 0} OR s.type = ANY(${filters.streamTypes ?? []}))
        AND (${filters.before === undefined} OR m.created_at < ${filters.before ?? new Date()})
        AND (${filters.after === undefined} OR m.created_at >= ${filters.after ?? new Date(0)})
      ORDER BY rank DESC
      LIMIT ${limit}
    `)

    return result.rows.map(mapRowToSearchResult)
  },

  /**
   * Hybrid search combining full-text and semantic search with RRF ranking.
   * Supports quoted phrases for exact matching: "chicken wingz"
   * All done in a single query using CTEs.
   *
   * RRF formula: score(d) = Σ(weight / (k + rank(d)))
   */
  async hybridSearch(db: Querier, params: HybridSearchParams): Promise<SearchResult[]> {
    const {
      query,
      phrases = [],
      embedding,
      streamIds,
      filters,
      limit,
      keywordWeight = 0.6,
      semanticWeight = 0.4,
      k = 60,
      semanticDistanceThreshold,
    } = params

    if (streamIds.length === 0) {
      return []
    }

    const embeddingLiteral = `[${embedding.join(",")}]`

    // Internal limit for each search type before RRF combination
    const internalLimit = 50

    const result = await db.query<SearchResultRow>(composeSql`
      WITH keyword_ranked AS (
        SELECT
          m.id,
          m.stream_id,
          m.content_markdown,
          m.content_json,
          m.author_id,
          m.author_type,
          m.sequence,
          ${sql`${sql.raw(REPLY_COUNT_SUBQUERY("m"))}`},
          m.metadata,
          m.edited_at,
          m.created_at,
          ROW_NUMBER() OVER (ORDER BY ts_rank(m.search_vector, websearch_to_tsquery('english', ${query})) DESC) as rank
        FROM messages m
        JOIN streams s ON m.stream_id = s.id
        WHERE m.stream_id = ANY(${streamIds})
          AND m.deleted_at IS NULL
          AND m.search_vector @@ websearch_to_tsquery('english', ${query})
          ${phrasePredicatesSql(phrases)}
          AND (${filters.authorId === undefined} OR m.author_id = ${filters.authorId ?? ""})
          AND (${filters.streamTypes === undefined || filters.streamTypes.length === 0} OR s.type = ANY(${filters.streamTypes ?? []}))
          AND (${filters.before === undefined} OR m.created_at < ${filters.before ?? new Date()})
          AND (${filters.after === undefined} OR m.created_at >= ${filters.after ?? new Date(0)})
        LIMIT ${internalLimit}
      ),
      semantic_ranked AS (
        SELECT
          m.id,
          m.stream_id,
          m.content_markdown,
          m.content_json,
          m.author_id,
          m.author_type,
          m.sequence,
          ${sql`${sql.raw(REPLY_COUNT_SUBQUERY("m"))}`},
          m.metadata,
          m.edited_at,
          m.created_at,
          ROW_NUMBER() OVER (ORDER BY m.embedding <=> ${embeddingLiteral}::vector) as rank
        FROM messages m
        JOIN streams s ON m.stream_id = s.id
        WHERE m.stream_id = ANY(${streamIds})
          AND m.deleted_at IS NULL
          AND m.embedding IS NOT NULL
          AND m.embedding <=> ${embeddingLiteral}::vector < ${semanticDistanceThreshold}
          ${phrasePredicatesSql(phrases)}
          AND (${filters.authorId === undefined} OR m.author_id = ${filters.authorId ?? ""})
          AND (${filters.streamTypes === undefined || filters.streamTypes.length === 0} OR s.type = ANY(${filters.streamTypes ?? []}))
          AND (${filters.before === undefined} OR m.created_at < ${filters.before ?? new Date()})
          AND (${filters.after === undefined} OR m.created_at >= ${filters.after ?? new Date(0)})
        LIMIT ${internalLimit}
      ),
      rrf_combined AS (
        SELECT
          COALESCE(k.id, s.id) as id,
          COALESCE(k.stream_id, s.stream_id) as stream_id,
          COALESCE(k.content_markdown, s.content_markdown) as content_markdown,
          COALESCE(k.content_json, s.content_json) as content_json,
          COALESCE(k.author_id, s.author_id) as author_id,
          COALESCE(k.author_type, s.author_type) as author_type,
          COALESCE(k.sequence, s.sequence) as sequence,
          COALESCE(k.reply_count, s.reply_count) as reply_count,
          COALESCE(k.metadata, s.metadata) as metadata,
          COALESCE(k.edited_at, s.edited_at) as edited_at,
          COALESCE(k.created_at, s.created_at) as created_at,
          COALESCE(${keywordWeight}::float / (${k}::float + k.rank), 0) +
          COALESCE(${semanticWeight}::float / (${k}::float + s.rank), 0) as rank
        FROM keyword_ranked k
        FULL OUTER JOIN semantic_ranked s ON k.id = s.id
      )
      SELECT * FROM rrf_combined
      ORDER BY rank DESC
      LIMIT ${limit}
    `)

    return result.rows.map(mapRowToSearchResult)
  },

  /**
   * Exact substring search using ILIKE.
   * Finds messages containing the query as a literal substring.
   * Results are ordered by recency (most recent first).
   *
   * Use this for error messages, IDs, or other literal text matching.
   */
  async exactSearch(db: Querier, params: FullTextSearchParams): Promise<SearchResult[]> {
    const { query, phrases = [], streamIds, filters, limit } = params
    const hasQuery = query.trim().length > 0

    if (streamIds.length === 0 || (!hasQuery && phrases.length === 0)) {
      return []
    }

    const exactQueryPredicate = hasQuery
      ? composeSql`AND m.content_markdown ILIKE '%' || ${escapeLike(query)} || '%'`
      : sql``

    const result = await db.query<SearchResultRow>(composeSql`
      SELECT
        m.id,
        m.stream_id,
        m.content_markdown,
        m.content_json,
        m.author_id,
        m.author_type,
        m.sequence,
        ${sql`${sql.raw(REPLY_COUNT_SUBQUERY("m"))}`},
        m.metadata,
        m.edited_at,
        m.created_at,
        0 as rank
      FROM messages m
      JOIN streams s ON m.stream_id = s.id
      WHERE m.stream_id = ANY(${streamIds})
        AND m.deleted_at IS NULL
        ${exactQueryPredicate}
        ${phrasePredicatesSql(phrases)}
        AND (${filters.authorId === undefined} OR m.author_id = ${filters.authorId ?? ""})
        AND (${filters.streamTypes === undefined || filters.streamTypes.length === 0} OR s.type = ANY(${filters.streamTypes ?? []}))
        AND (${filters.before === undefined} OR m.created_at < ${filters.before ?? new Date()})
        AND (${filters.after === undefined} OR m.created_at >= ${filters.after ?? new Date(0)})
      ORDER BY m.created_at DESC
      LIMIT ${limit}
    `)

    return result.rows.map(mapRowToSearchResult)
  },

  /**
   * Get public stream IDs in a workspace.
   * Used by agent access control for public_only access spec.
   */
  async getPublicStreams(
    db: Querier,
    workspaceId: string,
    options?: { streamTypes?: StreamType[]; archiveStatus?: ArchiveStatus[] }
  ): Promise<string[]> {
    const hasTypeFilter = options?.streamTypes && options.streamTypes.length > 0
    const { includeActive, includeArchived, filterAll } = parseArchiveStatusFilter(options?.archiveStatus)

    const result = await db.query<{ id: string }>(sql`
      SELECT id FROM streams
      WHERE workspace_id = ${workspaceId}
        AND visibility = ${Visibilities.PUBLIC}
        AND (${!hasTypeFilter} OR type = ANY(${options?.streamTypes ?? []}))
        AND (${filterAll} OR (${includeArchived} AND archived_at IS NOT NULL) OR (${!includeArchived} AND archived_at IS NULL))
    `)

    return result.rows.map((r) => r.id)
  },

  /**
   * Get a stream and all its thread descendants.
   * Used by agent access control for public_plus_stream access spec.
   */
  async getStreamWithThreads(db: Querier, streamId: string): Promise<string[]> {
    const result = await db.query<{ id: string }>(sql`
      SELECT id FROM streams
      WHERE id = ${streamId} OR root_stream_id = ${streamId}
    `)

    return result.rows.map((r) => r.id)
  },

  /**
   * Expand stream IDs to include their thread descendants, scoped to the
   * workspace. Used by the `in:` filter so "in this stream" covers replies
   * living in thread streams under it.
   */
  async expandStreamIdsWithThreads(db: Querier, workspaceId: string, streamIds: string[]): Promise<string[]> {
    if (streamIds.length === 0) {
      return []
    }

    const result = await db.query<{ id: string }>(sql`
      SELECT id FROM streams
      WHERE workspace_id = ${workspaceId}
        AND (id = ANY(${streamIds}) OR root_stream_id = ANY(${streamIds}))
    `)

    return result.rows.map((r) => r.id)
  },

  /**
   * Get accessible streams for an agent based on its access spec.
   *
   * Unlike getAccessibleStreamsWithMembers (which determines what a USER can access),
   * this determines what an AGENT can access based on invocation context.
   *
   * Access specs:
   * - user_full_access: Everything the specified user can access
   * - public_only: Only public streams
   * - public_plus_stream: Public streams + a specific stream and its threads
   * - user_intersection: Streams all specified users can access (for DMs)
   */
  async getAccessibleStreamsForAgent(
    db: Querier,
    spec: AgentAccessSpec,
    workspaceId: string,
    options?: { streamTypes?: StreamType[]; archiveStatus?: ArchiveStatus[] }
  ): Promise<string[]> {
    switch (spec.type) {
      case "user_full_access":
        return this.getAccessibleStreamsWithMembers(db, {
          workspaceId,
          userId: spec.userId,
          streamTypes: options?.streamTypes,
          archiveStatus: options?.archiveStatus,
        })

      case "public_only":
        return this.getPublicStreams(db, workspaceId, options)

      case "public_plus_stream": {
        const [publicIds, streamTreeIds] = await Promise.all([
          this.getPublicStreams(db, workspaceId, options),
          this.getStreamWithThreads(db, spec.streamId),
        ])

        return [...new Set([...publicIds, ...streamTreeIds])]
      }

      case "user_intersection": {
        const userIds = getValidatedUserIntersectionUserIds(spec.userIds)
        const hasTypeFilter = options?.streamTypes && options.streamTypes.length > 0
        const { includeActive, includeArchived, filterAll } = parseArchiveStatusFilter(options?.archiveStatus)

        const result = await db.query<{ id: string }>(sql`
          WITH requested_users AS (
            SELECT member_id
            FROM unnest(${userIds}::text[]) AS requested_users(member_id)
          ),
          shared_access AS (
            SELECT s.id, requested_users.member_id
            FROM streams s
            CROSS JOIN requested_users
            LEFT JOIN stream_members sm ON s.id = sm.stream_id AND sm.member_id = requested_users.member_id
            LEFT JOIN streams root ON s.root_stream_id = root.id
            LEFT JOIN stream_members root_sm ON root.id = root_sm.stream_id AND root_sm.member_id = requested_users.member_id
            WHERE s.workspace_id = ${workspaceId}
              AND (
                sm.member_id IS NOT NULL
                OR s.visibility = ${Visibilities.PUBLIC}
                OR (
                  s.root_stream_id IS NOT NULL
                  AND (root_sm.member_id IS NOT NULL OR root.visibility = ${Visibilities.PUBLIC})
                )
              )
              AND (${!hasTypeFilter} OR s.type = ANY(${options?.streamTypes ?? []}))
              AND (${filterAll} OR (${includeArchived} AND s.archived_at IS NOT NULL) OR (${!includeArchived} AND s.archived_at IS NULL))
          )
          SELECT id
          FROM shared_access
          GROUP BY id
          HAVING COUNT(DISTINCT member_id) = ${DM_PARTICIPANT_COUNT}
        `)

        return result.rows.map((r) => r.id)
      }
    }
  },
}
