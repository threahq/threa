import { sql, type Querier } from "../../db"
import type { MemoType, KnowledgeType, MemoStatus } from "@threa/types"
import { MEMO_KNOWLEDGE_TYPE_BOOST, MEMO_STREAM_TYPE_BOOST, MEMO_BOOST_DEFAULT } from "./config"

/**
 * B2 structural boost expression, generated from the config maps (single
 * source of truth, INV-33). Emitted into the *outer* stage of hybrid
 * search only — the inner access-scoped CTEs are untouched, so the boost
 * can reorder but never widen visibility (§3.1). `m.knowledge_type` and
 * the resolved stream type are plain columns/expressions here; the values
 * are numeric literals from a typed constant, so raw interpolation is safe.
 */
function buildBoostExpression(apply: boolean): ReturnType<typeof sql.raw> {
  if (!apply) return sql.raw("1.0")

  const caseFor = (column: string, map: Record<string, number>): string => {
    const arms = Object.entries(map)
      .map(([key, factor]) => `WHEN '${key.replace(/'/g, "''")}' THEN ${Number(factor)}`)
      .join(" ")
    return `CASE ${column} ${arms} ELSE ${Number(MEMO_BOOST_DEFAULT)} END`
  }

  const knowledge = caseFor("m.knowledge_type", MEMO_KNOWLEDGE_TYPE_BOOST)
  const stream = caseFor("COALESCE(msg_stream.type, conv_stream.type)", MEMO_STREAM_TYPE_BOOST)
  return sql.raw(`(${knowledge}) * (${stream})`)
}

interface MemoRow {
  id: string
  workspace_id: string
  memo_type: string
  source_message_id: string | null
  source_conversation_id: string | null
  title: string
  abstract: string
  key_points: string[]
  source_message_ids: string[]
  participant_ids: string[]
  knowledge_type: string
  tags: string[]
  parent_memo_id: string | null
  status: string
  version: number
  revision_reason: string | null
  created_at: Date
  updated_at: Date
  archived_at: Date | null
}

export interface Memo {
  id: string
  workspaceId: string
  memoType: MemoType
  sourceMessageId: string | null
  sourceConversationId: string | null
  title: string
  abstract: string
  keyPoints: string[]
  sourceMessageIds: string[]
  participantIds: string[]
  knowledgeType: KnowledgeType
  tags: string[]
  parentMemoId: string | null
  status: MemoStatus
  version: number
  revisionReason: string | null
  createdAt: Date
  updatedAt: Date
  archivedAt: Date | null
}

export interface InsertMemoParams {
  id: string
  workspaceId: string
  memoType: MemoType
  sourceMessageId?: string
  sourceConversationId?: string
  title: string
  abstract: string
  keyPoints?: string[]
  sourceMessageIds: string[]
  participantIds: string[]
  knowledgeType: KnowledgeType
  tags?: string[]
  parentMemoId?: string
  status?: MemoStatus
  version?: number
}

export interface UpdateMemoParams {
  title?: string
  abstract?: string
  keyPoints?: string[]
  sourceMessageIds?: string[]
  participantIds?: string[]
  knowledgeType?: KnowledgeType
  tags?: string[]
  parentMemoId?: string
  status?: MemoStatus
  version?: number
  revisionReason?: string
}

/**
 * Result from semantic memo search, including source stream info.
 */
export interface MemoSearchResult {
  memo: Memo
  distance: number
  sourceStream: {
    id: string
    type: string
    name: string | null
  } | null
  rootStream: {
    id: string
    type: string
    name: string | null
  } | null
}

export interface MemoSearchFilters {
  streamIds?: string[]
  memoTypes?: MemoType[]
  knowledgeTypes?: KnowledgeType[]
  tags?: string[]
  before?: Date
  after?: Date
}

export interface SemanticSearchParams {
  workspaceId: string
  embedding: number[]
  filters?: MemoSearchFilters
  limit?: number
  semanticDistanceThreshold?: number
}

export interface FullTextSearchParams {
  workspaceId: string
  query: string
  filters?: MemoSearchFilters
  limit?: number
}

export interface HybridSearchParams {
  workspaceId: string
  query: string
  embedding: number[]
  filters?: MemoSearchFilters
  limit?: number
  keywordWeight?: number
  semanticWeight?: number
  k?: number
  semanticDistanceThreshold?: number
  /** B2: apply the structural knowledge/stream-type boost (default true; bypassed for temporal intent). */
  applyStructuralBoost?: boolean
}

function mapRowToMemo(row: MemoRow): Memo {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    memoType: row.memo_type as MemoType,
    sourceMessageId: row.source_message_id,
    sourceConversationId: row.source_conversation_id,
    title: row.title,
    abstract: row.abstract,
    keyPoints: row.key_points,
    sourceMessageIds: row.source_message_ids,
    participantIds: row.participant_ids,
    knowledgeType: row.knowledge_type as KnowledgeType,
    tags: row.tags,
    parentMemoId: row.parent_memo_id,
    status: row.status as MemoStatus,
    version: row.version,
    revisionReason: row.revision_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  }
}

const SELECT_FIELDS = `
  id, workspace_id, memo_type, source_message_id, source_conversation_id,
  title, abstract, key_points, source_message_ids, participant_ids,
  knowledge_type, tags, parent_memo_id, status, version, revision_reason,
  created_at, updated_at, archived_at
`

const SELECT_FIELDS_PREFIXED = `
  m.id, m.workspace_id, m.memo_type, m.source_message_id, m.source_conversation_id,
  m.title, m.abstract, m.key_points, m.source_message_ids, m.participant_ids,
  m.knowledge_type, m.tags, m.parent_memo_id, m.status, m.version, m.revision_reason,
  m.created_at, m.updated_at, m.archived_at
`

interface MemoSearchRow extends MemoRow {
  stream_id: string | null
  stream_type: string | null
  stream_name: string | null
  root_stream_id: string | null
  root_stream_type: string | null
  root_stream_name: string | null
}

function mapMemoSearchResult(row: MemoSearchRow, distance: number): MemoSearchResult {
  return {
    memo: mapRowToMemo(row),
    distance,
    sourceStream: row.stream_id
      ? {
          id: row.stream_id,
          type: row.stream_type!,
          name: row.stream_name,
        }
      : null,
    rootStream: row.root_stream_id
      ? {
          id: row.root_stream_id,
          type: row.root_stream_type!,
          name: row.root_stream_name,
        }
      : null,
  }
}

export const MemoRepository = {
  async findById(db: Querier, id: string): Promise<Memo | null> {
    const result = await db.query<MemoRow>(sql`SELECT ${sql.raw(SELECT_FIELDS)} FROM memos WHERE id = ${id}`)
    if (!result.rows[0]) return null
    return mapRowToMemo(result.rows[0])
  },

  async findByWorkspace(
    db: Querier,
    workspaceId: string,
    options?: { status?: MemoStatus; type?: MemoType; limit?: number }
  ): Promise<Memo[]> {
    const limit = options?.limit ?? 50
    const conditions: string[] = [`workspace_id = $1`]
    const values: unknown[] = [workspaceId]
    let paramIndex = 2

    if (options?.status) {
      conditions.push(`status = $${paramIndex++}`)
      values.push(options.status)
    }
    if (options?.type) {
      conditions.push(`memo_type = $${paramIndex++}`)
      values.push(options.type)
    }

    values.push(limit)

    const query = `
      SELECT ${SELECT_FIELDS} FROM memos
      WHERE ${conditions.join(" AND ")}
      ORDER BY created_at DESC
      LIMIT $${paramIndex}
    `

    const result = await db.query<MemoRow>(query, values)
    return result.rows.map(mapRowToMemo)
  },

  async findByStream(
    db: Querier,
    streamId: string,
    options?: { status?: MemoStatus; limit?: number; orderBy?: "createdAt" | "updatedAt" }
  ): Promise<Memo[]> {
    const limit = options?.limit ?? 50
    const orderBy = options?.orderBy === "updatedAt" ? "updated_at" : "created_at"

    // Use UNION to fetch both:
    // 1. Conversation memos (via source_conversation_id -> conversations.stream_id)
    // 2. Message memos (via source_message_id -> messages.stream_id)
    // Status filter is optional - when provided, filter both branches with parameterized values
    const values: unknown[] = [streamId]
    let paramIndex = 2
    let statusClause = ""

    if (options?.status) {
      // Use parameterized query to prevent SQL injection
      statusClause = `AND m.status = $${paramIndex}`
      values.push(options.status)
      paramIndex++
    }

    values.push(limit)

    const query = `
      SELECT ${SELECT_FIELDS_PREFIXED} FROM memos m
      JOIN conversations c ON m.source_conversation_id = c.id
      WHERE c.stream_id = $1 ${statusClause}
      UNION
      SELECT ${SELECT_FIELDS_PREFIXED} FROM memos m
      JOIN messages msg ON m.source_message_id = msg.id
      WHERE msg.stream_id = $1 ${statusClause}
      ORDER BY ${orderBy} DESC
      LIMIT $${paramIndex}
    `

    const result = await db.query<MemoRow>(query, values)
    return result.rows.map(mapRowToMemo)
  },

  async findBySourceMessage(db: Querier, messageId: string): Promise<Memo | null> {
    const result = await db.query<MemoRow>(sql`
      SELECT ${sql.raw(SELECT_FIELDS)} FROM memos
      WHERE source_message_id = ${messageId}
    `)
    if (!result.rows[0]) return null
    return mapRowToMemo(result.rows[0])
  },

  async findBySourceConversation(db: Querier, conversationId: string): Promise<Memo[]> {
    const result = await db.query<MemoRow>(sql`
      SELECT ${sql.raw(SELECT_FIELDS)} FROM memos
      WHERE source_conversation_id = ${conversationId}
      ORDER BY version DESC
    `)
    return result.rows.map(mapRowToMemo)
  },

  async findActiveByConversation(db: Querier, conversationId: string): Promise<Memo | null> {
    const result = await db.query<MemoRow>(sql`
      SELECT ${sql.raw(SELECT_FIELDS)} FROM memos
      WHERE source_conversation_id = ${conversationId} AND status = 'active'
      ORDER BY version DESC
      LIMIT 1
    `)
    if (!result.rows[0]) return null
    return mapRowToMemo(result.rows[0])
  },

  async insert(db: Querier, params: InsertMemoParams): Promise<Memo> {
    const result = await db.query<MemoRow>(sql`
      INSERT INTO memos (
        id, workspace_id, memo_type, source_message_id, source_conversation_id,
        title, abstract, key_points, source_message_ids, participant_ids,
        knowledge_type, tags, parent_memo_id, status, version
      )
      VALUES (
        ${params.id},
        ${params.workspaceId},
        ${params.memoType},
        ${params.sourceMessageId ?? null},
        ${params.sourceConversationId ?? null},
        ${params.title},
        ${params.abstract},
        ${params.keyPoints ?? []},
        ${params.sourceMessageIds},
        ${params.participantIds},
        ${params.knowledgeType},
        ${params.tags ?? []},
        ${params.parentMemoId ?? null},
        ${params.status ?? "active"},
        ${params.version ?? 1}
      )
      RETURNING ${sql.raw(SELECT_FIELDS)}
    `)
    return mapRowToMemo(result.rows[0])
  },

  async update(db: Querier, id: string, params: UpdateMemoParams): Promise<Memo | null> {
    const updates: string[] = []
    const values: unknown[] = []
    let paramIndex = 1

    if (params.title !== undefined) {
      updates.push(`title = $${paramIndex++}`)
      values.push(params.title)
    }
    if (params.abstract !== undefined) {
      updates.push(`abstract = $${paramIndex++}`)
      values.push(params.abstract)
    }
    if (params.keyPoints !== undefined) {
      updates.push(`key_points = $${paramIndex++}`)
      values.push(params.keyPoints)
    }
    if (params.sourceMessageIds !== undefined) {
      updates.push(`source_message_ids = $${paramIndex++}`)
      values.push(params.sourceMessageIds)
    }
    if (params.participantIds !== undefined) {
      updates.push(`participant_ids = $${paramIndex++}`)
      values.push(params.participantIds)
    }
    if (params.knowledgeType !== undefined) {
      updates.push(`knowledge_type = $${paramIndex++}`)
      values.push(params.knowledgeType)
    }
    if (params.tags !== undefined) {
      updates.push(`tags = $${paramIndex++}`)
      values.push(params.tags)
    }
    if (params.parentMemoId !== undefined) {
      updates.push(`parent_memo_id = $${paramIndex++}`)
      values.push(params.parentMemoId)
    }
    if (params.status !== undefined) {
      updates.push(`status = $${paramIndex++}`)
      values.push(params.status)
    }
    if (params.version !== undefined) {
      updates.push(`version = $${paramIndex++}`)
      values.push(params.version)
    }
    if (params.revisionReason !== undefined) {
      updates.push(`revision_reason = $${paramIndex++}`)
      values.push(params.revisionReason)
    }

    if (updates.length === 0) {
      return this.findById(db, id)
    }

    updates.push(`updated_at = NOW()`)
    values.push(id)

    const query = `
      UPDATE memos
      SET ${updates.join(", ")}
      WHERE id = $${paramIndex}
      RETURNING ${SELECT_FIELDS}
    `

    const result = await db.query<MemoRow>(query, values)
    if (!result.rows[0]) return null
    return mapRowToMemo(result.rows[0])
  },

  async updateEmbedding(db: Querier, id: string, embedding: number[]): Promise<void> {
    await db.query(sql`
      UPDATE memos
      SET embedding = ${JSON.stringify(embedding)}::vector,
          updated_at = NOW()
      WHERE id = ${id}
    `)
  },

  async supersede(db: Querier, id: string, reason: string): Promise<Memo | null> {
    const result = await db.query<MemoRow>(sql`
      UPDATE memos
      SET status = 'superseded',
          revision_reason = ${reason},
          updated_at = NOW()
      WHERE id = ${id}
      RETURNING ${sql.raw(SELECT_FIELDS)}
    `)
    if (!result.rows[0]) return null
    return mapRowToMemo(result.rows[0])
  },

  async archive(db: Querier, id: string): Promise<Memo | null> {
    const result = await db.query<MemoRow>(sql`
      UPDATE memos
      SET status = 'archived',
          archived_at = NOW(),
          updated_at = NOW()
      WHERE id = ${id}
      RETURNING ${sql.raw(SELECT_FIELDS)}
    `)
    if (!result.rows[0]) return null
    return mapRowToMemo(result.rows[0])
  },

  async getAllTags(db: Querier, workspaceId: string): Promise<string[]> {
    const result = await db.query<{ tag: string }>(sql`
      SELECT DISTINCT unnest(tags) as tag
      FROM memos
      WHERE workspace_id = ${workspaceId} AND status = 'active'
      ORDER BY tag
    `)
    return result.rows.map((r) => r.tag)
  },

  /**
   * Semantic search over memo abstracts using vector similarity.
   *
   * Finds memos whose abstract embedding is similar to the query embedding.
   * Optionally filters to memos linked to specific streams.
   * Returns memos with their source stream info for navigation.
   */
  async semanticSearch(db: Querier, params: SemanticSearchParams): Promise<MemoSearchResult[]> {
    const { workspaceId, embedding, filters, limit = 10, semanticDistanceThreshold = 0.8 } = params
    const streamIds = filters?.streamIds
    const hasStreamFilter = streamIds && streamIds.length > 0
    const hasMemoTypeFilter = Boolean(filters?.memoTypes?.length)
    const hasKnowledgeTypeFilter = Boolean(filters?.knowledgeTypes?.length)
    const hasTagFilter = Boolean(filters?.tags?.length)

    const embeddingLiteral = `[${embedding.join(",")}]`

    // Join through either source_message_id or source_conversation_id to get stream info
    const result = await db.query<MemoSearchRow & { distance: number }>(sql`
      WITH memo_with_stream AS (
        SELECT
          ${sql.raw(SELECT_FIELDS_PREFIXED)},
          m.embedding <=> ${embeddingLiteral}::vector as distance,
          COALESCE(msg_stream.id, conv_stream.id) as stream_id,
          COALESCE(msg_stream.type, conv_stream.type) as stream_type,
          COALESCE(msg_stream.display_name, msg_stream.slug, conv_stream.display_name, conv_stream.slug) as stream_name,
          root_stream.id as root_stream_id,
          root_stream.type as root_stream_type,
          COALESCE(root_stream.display_name, root_stream.slug) as root_stream_name
        FROM memos m
        LEFT JOIN messages msg ON m.source_message_id = msg.id
        LEFT JOIN streams msg_stream ON msg.stream_id = msg_stream.id
        LEFT JOIN conversations conv ON m.source_conversation_id = conv.id
        LEFT JOIN streams conv_stream ON conv.stream_id = conv_stream.id
        LEFT JOIN streams root_stream ON root_stream.id = COALESCE(msg_stream.root_stream_id, conv_stream.root_stream_id)
        WHERE m.workspace_id = ${workspaceId}
          AND m.status = 'active'
          AND m.embedding IS NOT NULL
          AND m.embedding <=> ${embeddingLiteral}::vector < ${semanticDistanceThreshold}
          AND (${!hasMemoTypeFilter} OR m.memo_type = ANY(${filters?.memoTypes ?? []}))
          AND (${!hasKnowledgeTypeFilter} OR m.knowledge_type = ANY(${filters?.knowledgeTypes ?? []}))
          AND (${!hasTagFilter} OR m.tags && ${filters?.tags ?? []})
          AND (${filters?.before === undefined} OR m.created_at < ${filters?.before ?? new Date()})
          AND (${filters?.after === undefined} OR m.created_at >= ${filters?.after ?? new Date(0)})
      )
      SELECT * FROM memo_with_stream
      WHERE (${!hasStreamFilter} OR stream_id = ANY(${streamIds ?? []}) OR root_stream_id = ANY(${streamIds ?? []}))
      ORDER BY distance ASC
      LIMIT ${limit}
    `)

    return result.rows.map((row) => mapMemoSearchResult(row, row.distance))
  },

  /**
   * Full-text search over memo title, abstract, and key points.
   *
   * Uses PostgreSQL full-text search for exact phrase matching.
   * Optionally filters to memos linked to specific streams.
   * Returns memos with their source stream info for navigation.
   */
  async fullTextSearch(db: Querier, params: FullTextSearchParams): Promise<MemoSearchResult[]> {
    const { workspaceId, query, filters, limit = 10 } = params
    const streamIds = filters?.streamIds
    const hasStreamFilter = streamIds && streamIds.length > 0
    const hasMemoTypeFilter = Boolean(filters?.memoTypes?.length)
    const hasKnowledgeTypeFilter = Boolean(filters?.knowledgeTypes?.length)
    const hasTagFilter = Boolean(filters?.tags?.length)

    if (!query.trim()) {
      const result = await db.query<MemoSearchRow>(sql`
        WITH memo_with_stream AS (
          SELECT
            ${sql.raw(SELECT_FIELDS_PREFIXED)},
            COALESCE(msg_stream.id, conv_stream.id) as stream_id,
            COALESCE(msg_stream.type, conv_stream.type) as stream_type,
            COALESCE(msg_stream.display_name, msg_stream.slug, conv_stream.display_name, conv_stream.slug) as stream_name,
            root_stream.id as root_stream_id,
            root_stream.type as root_stream_type,
            COALESCE(root_stream.display_name, root_stream.slug) as root_stream_name
          FROM memos m
          LEFT JOIN messages msg ON m.source_message_id = msg.id
          LEFT JOIN streams msg_stream ON msg.stream_id = msg_stream.id
          LEFT JOIN conversations conv ON m.source_conversation_id = conv.id
          LEFT JOIN streams conv_stream ON conv.stream_id = conv_stream.id
          LEFT JOIN streams root_stream ON root_stream.id = COALESCE(msg_stream.root_stream_id, conv_stream.root_stream_id)
          WHERE m.workspace_id = ${workspaceId}
            AND m.status = 'active'
            AND (${!hasMemoTypeFilter} OR m.memo_type = ANY(${filters?.memoTypes ?? []}))
            AND (${!hasKnowledgeTypeFilter} OR m.knowledge_type = ANY(${filters?.knowledgeTypes ?? []}))
            AND (${!hasTagFilter} OR m.tags && ${filters?.tags ?? []})
            AND (${filters?.before === undefined} OR m.created_at < ${filters?.before ?? new Date()})
            AND (${filters?.after === undefined} OR m.created_at >= ${filters?.after ?? new Date(0)})
        )
        SELECT * FROM memo_with_stream
        WHERE (${!hasStreamFilter} OR stream_id = ANY(${streamIds ?? []}) OR root_stream_id = ANY(${streamIds ?? []}))
        ORDER BY updated_at DESC
        LIMIT ${limit}
      `)

      return result.rows.map((row) => mapMemoSearchResult(row, 0))
    }

    // Convert query to tsquery - plainto_tsquery handles most cases,
    // but we use websearch_to_tsquery for phrase support
    const result = await db.query<MemoSearchRow & { rank: number }>(sql`
      WITH memo_with_stream AS (
        SELECT
          ${sql.raw(SELECT_FIELDS_PREFIXED)},
          ts_rank(
            to_tsvector('english', m.title || ' ' || m.abstract || ' ' || array_to_string(m.key_points, ' ')),
            websearch_to_tsquery('english', ${query})
          ) as rank,
          COALESCE(msg_stream.id, conv_stream.id) as stream_id,
          COALESCE(msg_stream.type, conv_stream.type) as stream_type,
          COALESCE(msg_stream.display_name, msg_stream.slug, conv_stream.display_name, conv_stream.slug) as stream_name,
          root_stream.id as root_stream_id,
          root_stream.type as root_stream_type,
          COALESCE(root_stream.display_name, root_stream.slug) as root_stream_name
        FROM memos m
        LEFT JOIN messages msg ON m.source_message_id = msg.id
        LEFT JOIN streams msg_stream ON msg.stream_id = msg_stream.id
        LEFT JOIN conversations conv ON m.source_conversation_id = conv.id
        LEFT JOIN streams conv_stream ON conv.stream_id = conv_stream.id
        LEFT JOIN streams root_stream ON root_stream.id = COALESCE(msg_stream.root_stream_id, conv_stream.root_stream_id)
        WHERE m.workspace_id = ${workspaceId}
          AND m.status = 'active'
          AND (${!hasMemoTypeFilter} OR m.memo_type = ANY(${filters?.memoTypes ?? []}))
          AND (${!hasKnowledgeTypeFilter} OR m.knowledge_type = ANY(${filters?.knowledgeTypes ?? []}))
          AND (${!hasTagFilter} OR m.tags && ${filters?.tags ?? []})
          AND (${filters?.before === undefined} OR m.created_at < ${filters?.before ?? new Date()})
          AND (${filters?.after === undefined} OR m.created_at >= ${filters?.after ?? new Date(0)})
          AND to_tsvector('english', m.title || ' ' || m.abstract || ' ' || array_to_string(m.key_points, ' '))
              @@ websearch_to_tsquery('english', ${query})
      )
      SELECT * FROM memo_with_stream
      WHERE (${!hasStreamFilter} OR stream_id = ANY(${streamIds ?? []}) OR root_stream_id = ANY(${streamIds ?? []}))
      ORDER BY rank DESC
      LIMIT ${limit}
    `)

    return result.rows.map((row) => mapMemoSearchResult(row, 1 - row.rank))
  },

  /**
   * Hybrid memo search: keyword (full-text) + semantic (vector) candidate
   * lists fused with Reciprocal Rank Fusion (gbrain concept B1).
   *
   * Access discipline (§3.1): the accessible-stream predicate is pushed into
   * **both** inner candidate CTEs *before* RRF, never as a post-filter — a
   * private high-scorer must not displace a public result the viewer should
   * have seen, and the internal per-list LIMIT must be filled from
   * accessible rows only. Thread memos inherit access from their root stream,
   * same as the other memo search paths.
   *
   * RRF score(d) = Σ(weight / (k + rank(d))); higher score = better. The
   * returned `distance` is `1 / (1 + score)` so the existing "lower is
   * better" contract holds, though rows are already SQL-ordered.
   */
  async hybridSearch(db: Querier, params: HybridSearchParams): Promise<MemoSearchResult[]> {
    const {
      workspaceId,
      query,
      embedding,
      filters,
      limit = 10,
      keywordWeight = 0.5,
      semanticWeight = 0.5,
      k = 60,
      semanticDistanceThreshold = 0.8,
      applyStructuralBoost = true,
    } = params

    if (!query.trim()) return []

    const streamIds = filters?.streamIds
    const hasStreamFilter = streamIds && streamIds.length > 0
    const hasMemoTypeFilter = Boolean(filters?.memoTypes?.length)
    const hasKnowledgeTypeFilter = Boolean(filters?.knowledgeTypes?.length)
    const hasTagFilter = Boolean(filters?.tags?.length)

    const embeddingLiteral = `[${embedding.join(",")}]`
    const tsvector = sql.raw(
      "to_tsvector('english', m.title || ' ' || m.abstract || ' ' || array_to_string(m.key_points, ' '))"
    )
    const streamJoins = sql.raw(`
      LEFT JOIN messages msg ON m.source_message_id = msg.id
      LEFT JOIN streams msg_stream ON msg.stream_id = msg_stream.id
      LEFT JOIN conversations conv ON m.source_conversation_id = conv.id
      LEFT JOIN streams conv_stream ON conv.stream_id = conv_stream.id
      LEFT JOIN streams root_stream ON root_stream.id = COALESCE(msg_stream.root_stream_id, conv_stream.root_stream_id)
    `)

    // Per-list candidate cap before fusion. The 50 floor matches the
    // message hybrid path; widen to the requested pool so a larger
    // configured candidate pool is actually filled before rerank/trim.
    const internalLimit = Math.max(limit, 50)

    // B2: structural boost, applied only in the outer hydrate stage.
    const boost = buildBoostExpression(applyStructuralBoost)

    const result = await db.query<MemoSearchRow & { score: number }>(sql`
      WITH keyword_ranked AS (
        SELECT
          m.id,
          ROW_NUMBER() OVER (
            ORDER BY ts_rank(${tsvector}, websearch_to_tsquery('english', ${query})) DESC
          ) as rank
        FROM memos m
        ${streamJoins}
        WHERE m.workspace_id = ${workspaceId}
          AND m.status = 'active'
          AND (
            ${!hasStreamFilter}
            OR COALESCE(msg_stream.id, conv_stream.id) = ANY(${streamIds ?? []})
            OR root_stream.id = ANY(${streamIds ?? []})
          )
          AND (${!hasMemoTypeFilter} OR m.memo_type = ANY(${filters?.memoTypes ?? []}))
          AND (${!hasKnowledgeTypeFilter} OR m.knowledge_type = ANY(${filters?.knowledgeTypes ?? []}))
          AND (${!hasTagFilter} OR m.tags && ${filters?.tags ?? []})
          AND (${filters?.before === undefined} OR m.created_at < ${filters?.before ?? new Date()})
          AND (${filters?.after === undefined} OR m.created_at >= ${filters?.after ?? new Date(0)})
          AND ${tsvector} @@ websearch_to_tsquery('english', ${query})
        LIMIT ${internalLimit}
      ),
      semantic_ranked AS (
        SELECT
          m.id,
          ROW_NUMBER() OVER (ORDER BY m.embedding <=> ${embeddingLiteral}::vector) as rank
        FROM memos m
        ${streamJoins}
        WHERE m.workspace_id = ${workspaceId}
          AND m.status = 'active'
          AND m.embedding IS NOT NULL
          AND m.embedding <=> ${embeddingLiteral}::vector < ${semanticDistanceThreshold}
          AND (
            ${!hasStreamFilter}
            OR COALESCE(msg_stream.id, conv_stream.id) = ANY(${streamIds ?? []})
            OR root_stream.id = ANY(${streamIds ?? []})
          )
          AND (${!hasMemoTypeFilter} OR m.memo_type = ANY(${filters?.memoTypes ?? []}))
          AND (${!hasKnowledgeTypeFilter} OR m.knowledge_type = ANY(${filters?.knowledgeTypes ?? []}))
          AND (${!hasTagFilter} OR m.tags && ${filters?.tags ?? []})
          AND (${filters?.before === undefined} OR m.created_at < ${filters?.before ?? new Date()})
          AND (${filters?.after === undefined} OR m.created_at >= ${filters?.after ?? new Date(0)})
        LIMIT ${internalLimit}
      ),
      fused AS (
        SELECT
          COALESCE(kr.id, sr.id) as id,
          COALESCE(${keywordWeight}::float / (${k}::float + kr.rank), 0) +
          COALESCE(${semanticWeight}::float / (${k}::float + sr.rank), 0) as score
        FROM keyword_ranked kr
        FULL OUTER JOIN semantic_ranked sr ON kr.id = sr.id
      )
      SELECT
        ${sql.raw(SELECT_FIELDS_PREFIXED)},
        (f.score * ${boost}) as score,
        COALESCE(msg_stream.id, conv_stream.id) as stream_id,
        COALESCE(msg_stream.type, conv_stream.type) as stream_type,
        COALESCE(msg_stream.display_name, msg_stream.slug, conv_stream.display_name, conv_stream.slug) as stream_name,
        root_stream.id as root_stream_id,
        root_stream.type as root_stream_type,
        COALESCE(root_stream.display_name, root_stream.slug) as root_stream_name
      FROM fused f
      JOIN memos m ON m.id = f.id
      ${streamJoins}
      ORDER BY (f.score * ${boost}) DESC
      LIMIT ${limit}
    `)

    return result.rows.map((row) => mapMemoSearchResult(row, 1 / (1 + row.score)))
  },

  async exactSearch(db: Querier, params: FullTextSearchParams): Promise<MemoSearchResult[]> {
    const { workspaceId, query, filters, limit = 10 } = params
    const streamIds = filters?.streamIds
    const hasStreamFilter = streamIds && streamIds.length > 0
    const hasMemoTypeFilter = Boolean(filters?.memoTypes?.length)
    const hasKnowledgeTypeFilter = Boolean(filters?.knowledgeTypes?.length)
    const hasTagFilter = Boolean(filters?.tags?.length)

    if (!query.trim()) {
      return this.fullTextSearch(db, { workspaceId, query, filters, limit })
    }

    const escapedQuery = query.replace(/[%_\\]/g, "\\$&")

    const result = await db.query<MemoSearchRow>(sql`
      WITH memo_with_stream AS (
        SELECT
          ${sql.raw(SELECT_FIELDS_PREFIXED)},
          COALESCE(msg_stream.id, conv_stream.id) as stream_id,
          COALESCE(msg_stream.type, conv_stream.type) as stream_type,
          COALESCE(msg_stream.display_name, msg_stream.slug, conv_stream.display_name, conv_stream.slug) as stream_name,
          root_stream.id as root_stream_id,
          root_stream.type as root_stream_type,
          COALESCE(root_stream.display_name, root_stream.slug) as root_stream_name
        FROM memos m
        LEFT JOIN messages msg ON m.source_message_id = msg.id
        LEFT JOIN streams msg_stream ON msg.stream_id = msg_stream.id
        LEFT JOIN conversations conv ON m.source_conversation_id = conv.id
        LEFT JOIN streams conv_stream ON conv.stream_id = conv_stream.id
        LEFT JOIN streams root_stream ON root_stream.id = COALESCE(msg_stream.root_stream_id, conv_stream.root_stream_id)
        WHERE m.workspace_id = ${workspaceId}
          AND m.status = 'active'
          AND (${!hasMemoTypeFilter} OR m.memo_type = ANY(${filters?.memoTypes ?? []}))
          AND (${!hasKnowledgeTypeFilter} OR m.knowledge_type = ANY(${filters?.knowledgeTypes ?? []}))
          AND (${!hasTagFilter} OR m.tags && ${filters?.tags ?? []})
          AND (${filters?.before === undefined} OR m.created_at < ${filters?.before ?? new Date()})
          AND (${filters?.after === undefined} OR m.created_at >= ${filters?.after ?? new Date(0)})
          AND (
            m.title ILIKE '%' || ${escapedQuery} || '%'
            OR m.abstract ILIKE '%' || ${escapedQuery} || '%'
            OR EXISTS (
              SELECT 1
              FROM unnest(m.key_points) AS key_point
              WHERE key_point ILIKE '%' || ${escapedQuery} || '%'
            )
          )
      )
      SELECT * FROM memo_with_stream
      WHERE (${!hasStreamFilter} OR stream_id = ANY(${streamIds ?? []}) OR root_stream_id = ANY(${streamIds ?? []}))
      ORDER BY updated_at DESC
      LIMIT ${limit}
    `)

    return result.rows.map((row) => mapMemoSearchResult(row, 0))
  },
}
