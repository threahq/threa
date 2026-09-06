import { sql, type Querier } from "../../db"
import { detectSearchConfig } from "../../lib/text-search-config"
import type { MemoType, KnowledgeType, MemoStatus, AuthoredByKind, MemoScope, MemoEmbedSummary } from "@threahq/types"
import {
  MEMO_KNOWLEDGE_TYPE_BOOST,
  MEMO_STREAM_TYPE_BOOST,
  MEMO_AUTHORED_BY_KIND_BOOST,
  MEMO_BOOST_DEFAULT,
} from "./config"

/** The text memo full-text search runs over, and so the text its stemmer is detected from. */
export function memoSearchText(memo: { title: string; abstract: string; keyPoints?: string[] | null }): string {
  return `${memo.title} ${memo.abstract} ${(memo.keyPoints ?? []).join(" ")}`
}

/**
 * Memo full-text search computes its tsvector per row — no stored column, no
 * index — so both the vector and the query are stemmed with the config the row
 * itself was written in, rather than the OR-across-configs tsquery an
 * index-backed `search_vector` needs (`tsqueryAcrossConfigsSql`).
 */
const MEMO_TSVECTOR = sql.raw(
  "to_tsvector(text_search_config(m.search_config), m.title || ' ' || m.abstract || ' ' || array_to_string(m.key_points, ' '))"
)
const MEMO_ROW_CONFIG = sql.raw("text_search_config(m.search_config)")

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
  const authorship = caseFor("m.authored_by_kind", MEMO_AUTHORED_BY_KIND_BOOST)
  return sql.raw(`(${knowledge}) * (${stream}) * (${authorship})`)
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
  authored_by_kind: string
  source_session_id: string | null
  scope: string
  scope_user_id: string | null
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
  authoredByKind: AuthoredByKind
  sourceSessionId: string | null
  scope: MemoScope
  scopeUserId: string | null
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
  /** Defaults to `'pipeline'` (the passive extractor); `save_memo` sets `'agent'`. */
  authoredByKind?: AuthoredByKind
  /** The agent session that wrote this memo (agent authorship only). */
  sourceSessionId?: string
  /** Visibility tier (roadmap 6.4); defaults to `'workspace'`. */
  scope?: MemoScope
  /** Owner for `'user'` scope; must be set iff `scope === 'user'` (DB CHECK). */
  scopeUserId?: string | null
}

export interface UpdateMemoParams {
  title?: string
  abstract?: string
  keyPoints?: string[]
  /**
   * Stemmer for the memo's full-text search. `insert` derives it from the text
   * it is given; an update only carries the fields that changed, so the caller
   * detects it from the merged memo (`memoSearchText`) and passes it here.
   */
  searchConfig?: string
  sourceMessageIds?: string[]
  participantIds?: string[]
  knowledgeType?: KnowledgeType
  tags?: string[]
  parentMemoId?: string
  status?: MemoStatus
  version?: number
  revisionReason?: string
}

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
  /**
   * Which memo lifecycle statuses to return. Defaults to `["active"]` so
   * agent retrieval (the researcher) keeps excluding archived/superseded
   * memos untouched; only the memory explorer opts into other statuses to
   * let a user browse and un-archive them.
   */
  statuses?: MemoStatus[]
  /**
   * The user retrieving these memos (roadmap 6.4). A `user`-scoped memo surfaces
   * only when its `scope_user_id` matches this id; omit it and user-scoped memos
   * are excluded entirely (fail closed). `stream`/`workspace` memos are
   * unaffected — their visibility is the `streamIds` access filter above. This is
   * a visibility GATE, always safe to apply; it is not the `scope` positive
   * filter below.
   */
  viewerUserId?: string
  /**
   * Positive filter to one visibility tier (roadmap 6.4) — the explorer's "About
   * you" view passes `'user'` to list only the viewer's private-tier memos.
   * Independent of `viewerUserId`: the gate still applies, so `scope: 'user'`
   * without a matching `viewerUserId` returns nothing.
   */
  scope?: MemoScope
}

/**
 * The 6.4 scope predicate, shared by every memo search path (INV-35). Two guards:
 * the optional positive `scope` filter, and the always-safe user-scope
 * visibility gate (a `user` memo is visible only to its owner; no viewer ⇒ no
 * user memos). Emitted with the same boolean-guard interpolation the other
 * filters use — squid `sql` renders a JS boolean as a SQL literal, so a disabled
 * guard collapses to `TRUE`/`FALSE` at plan time. `m` is the memo table alias
 * every search CTE uses.
 */
function scopeConditions(filters: MemoSearchFilters | undefined) {
  const hasScopeFilter = filters?.scope !== undefined
  const hasViewer = filters?.viewerUserId !== undefined
  return {
    hasScopeFilter,
    scope: filters?.scope ?? "workspace",
    hasViewer,
    viewerUserId: filters?.viewerUserId ?? "",
  }
}

const DEFAULT_SEARCH_STATUSES: MemoStatus[] = ["active"]

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
    authoredByKind: row.authored_by_kind as AuthoredByKind,
    sourceSessionId: row.source_session_id,
    scope: row.scope as MemoScope,
    scopeUserId: row.scope_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  }
}

const SELECT_FIELDS = `
  id, workspace_id, memo_type, source_message_id, source_conversation_id,
  title, abstract, key_points, source_message_ids, participant_ids,
  knowledge_type, tags, parent_memo_id, status, version, revision_reason,
  authored_by_kind, source_session_id, scope, scope_user_id,
  created_at, updated_at, archived_at
`

const SELECT_FIELDS_PREFIXED = `
  m.id, m.workspace_id, m.memo_type, m.source_message_id, m.source_conversation_id,
  m.title, m.abstract, m.key_points, m.source_message_ids, m.participant_ids,
  m.knowledge_type, m.tags, m.parent_memo_id, m.status, m.version, m.revision_reason,
  m.authored_by_kind, m.source_session_id, m.scope, m.scope_user_id,
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

  /**
   * Read a memo under a row lock, for a caller that derives what it writes from
   * fields it is not itself supplying (INV-20). Blocks until a concurrent edit
   * of the same memo commits, then returns that committed row — so pass a
   * transaction client, never the pool.
   */
  async findByIdForUpdate(db: Querier, workspaceId: string, id: string): Promise<Memo | null> {
    const result = await db.query<MemoRow>(sql`
      SELECT ${sql.raw(SELECT_FIELDS)} FROM memos
      WHERE id = ${id} AND workspace_id = ${workspaceId}
      FOR UPDATE
    `)
    if (!result.rows[0]) return null
    return mapRowToMemo(result.rows[0])
  },

  /**
   * Batch-fetch memos by id, scoped to a workspace (INV-8). Used by callers
   * whose ids come from untrusted content (e.g. a `memoEmbed` pointer pulled
   * from contentJson) where the implicit workspace boundary can't be trusted.
   */
  async findByIdsInWorkspace(db: Querier, workspaceId: string, ids: string[]): Promise<Map<string, Memo>> {
    if (ids.length === 0) return new Map()
    const result = await db.query<MemoRow>(sql`
      SELECT ${sql.raw(SELECT_FIELDS)} FROM memos
      WHERE id = ANY(${ids}) AND workspace_id = ${workspaceId}
    `)
    return new Map(result.rows.map((row) => [row.id, mapRowToMemo(row)]))
  },

  /**
   * Card content for memos referenced by a message in `citingRootStreamId`,
   * for the payload that message ships on (INV-56: one batch, never per card).
   *
   * The access predicate is ROOM-UNIFORM, not per-viewer, because the payload
   * is delivered to a room: a summary is emitted only when every viewer of the
   * citing stream can open the memo. That means the memo's source stream
   * RESOLVED TO ITS ROOT is the citing root, or that root is public.
   *
   * Resolving to the root is the load-bearing part. A thread copies its root's
   * `visibility` at creation and is never re-synced, so a thread of a channel
   * that was later privatized still reads `public` on its own row —
   * `messaging/sharing/access-check.ts` documents that trap and closes it the
   * same way. Checking `s.visibility` here instead would leak exactly those
   * memos.
   *
   * `scope <> 'user'` keeps the private tier (roadmap 6.4) off the wire
   * unconditionally: a user-scoped memo is visible to its owner alone, and no
   * room is uniformly its owner.
   *
   * No status filter — an archived or superseded memo resolves on the detail
   * path today, so summarising it preserves behaviour rather than changing it.
   */
  async findEmbedSummaries(
    db: Querier,
    workspaceId: string,
    memoIds: string[],
    citingRootStreamId: string
  ): Promise<Map<string, MemoEmbedSummary>> {
    if (memoIds.length === 0) return new Map()
    const result = await db.query<{
      id: string
      title: string
      knowledge_type: string
      memo_type: string
      tags: string[]
      updated_at: Date
      card_version: number
    }>(sql`
      SELECT m.id, m.title, m.knowledge_type, m.memo_type, m.tags, m.updated_at, m.card_version
      FROM memos m
      LEFT JOIN messages src_msg ON src_msg.id = m.source_message_id
      LEFT JOIN conversations src_conv ON src_conv.id = m.source_conversation_id
      LEFT JOIN messages first_msg ON first_msg.id = m.source_message_ids[1]
      LEFT JOIN streams s ON s.id = COALESCE(src_msg.stream_id, src_conv.stream_id, first_msg.stream_id)
      LEFT JOIN streams root ON root.id = COALESCE(s.root_stream_id, s.id)
      WHERE m.id = ANY(${memoIds})
        AND m.workspace_id = ${workspaceId}
        AND m.scope <> 'user'
        AND root.id IS NOT NULL
        AND (root.id = ${citingRootStreamId} OR root.visibility = 'public')
    `)
    return new Map(
      result.rows.map((row) => [
        row.id,
        {
          memoId: row.id,
          title: row.title,
          knowledgeType: row.knowledge_type as KnowledgeType,
          memoType: row.memo_type as MemoType,
          tags: row.tags,
          updatedAt: row.updated_at.toISOString(),
          version: row.card_version,
        },
      ])
    )
  },

  /**
   * Streams whose live messages cite `memoId`, so an update to the memo can be
   * pushed to exactly those rooms.
   *
   * Matches on the markdown pointer (`(memo:<id>)`), which every authored form
   * serializes to — the picker's node, a pasted link, an API-written body. The
   * id is a prefixed ULID, so the pattern cannot collide with a longer id, and
   * it is passed as a parameter rather than interpolated.
   *
   * Workspace scoping goes through `streams`: `messages` carries no
   * `workspace_id` (INV-8's exemption is the join, not the column).
   */
  async findCitingStreamIds(db: Querier, workspaceId: string, memoId: string): Promise<string[]> {
    const result = await db.query<{ stream_id: string }>(sql`
      SELECT DISTINCT m.stream_id
      FROM messages m
      JOIN streams s ON s.id = m.stream_id
      WHERE s.workspace_id = ${workspaceId}
        AND m.deleted_at IS NULL
        AND m.content_markdown LIKE ${"%(memo:" + memoId + ")%"}
    `)
    return result.rows.map((row) => row.stream_id)
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

    // UNION over the two source paths: conversation memos (via source_conversation_id)
    // and message memos (via source_message_id), each resolving to a stream_id.
    const values: unknown[] = [streamId]
    let paramIndex = 2
    let statusClause = ""

    if (options?.status) {
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

  /**
   * Of the given conversation ids, which have produced at least one active
   * captured memo — the Decisions/Knowledge lens signal for the board
   *. Batch (INV-56): one `SELECT DISTINCT` over
   * `= ANY($ids)`, not a presence check per card. Workspace-scoped (INV-8) and
   * `status = 'active'` (matching `findActiveBySourceConversation`), so an
   * archived/superseded memo stops counting as captured knowledge. Empty input
   * short-circuits.
   */
  async findConversationIdsWithMemos(
    db: Querier,
    workspaceId: string,
    conversationIds: string[]
  ): Promise<Set<string>> {
    if (conversationIds.length === 0) return new Set()
    const result = await db.query<{ source_conversation_id: string }>(sql`
      SELECT DISTINCT source_conversation_id FROM memos
      WHERE workspace_id = ${workspaceId}
        AND status = 'active'
        AND source_conversation_id = ANY(${conversationIds})
    `)
    return new Set(result.rows.map((row) => row.source_conversation_id))
  },

  async findActiveBySourceConversation(db: Querier, conversationId: string): Promise<Memo[]> {
    const result = await db.query<MemoRow>(sql`
      SELECT ${sql.raw(SELECT_FIELDS)} FROM memos
      WHERE source_conversation_id = ${conversationId} AND status = 'active'
      ORDER BY created_at ASC
    `)
    return result.rows.map(mapRowToMemo)
  },

  /**
   * Closest active memo in `streamId` whose abstract embedding sits within
   * `maxDistance` (pgvector cosine distance) of `embedding`. Drives the dedup
   * gate (INV-20) for repeats both across conversations AND within one: the
   * revision prompt asks the memorizer to emit only new/changed topics, but in
   * practice it re-emits near-identical rewordings on every re-processing of a
   * long conversation, so the embedding gate — not the prompt — is the
   * authoritative guard. Returns null when nothing is close enough.
   *
   * Dedup is scoped to the candidate's own visibility tier (roadmap 6.4): a
   * `user`-scoped candidate only dedups against the same owner's memos, and a
   * non-`user` candidate only against non-`user` memos. Otherwise a private memo
   * could be silently dropped as a "duplicate" of a shared one (or vice versa),
   * collapsing the tier split the scope exists to enforce.
   */
  async findNearDuplicate(
    db: Querier,
    params: {
      workspaceId: string
      streamId: string
      embedding: number[]
      maxDistance: number
      scope?: MemoScope
      scopeUserId?: string | null
    }
  ): Promise<{ memo: Memo; distance: number } | null> {
    const { workspaceId, streamId, embedding, maxDistance, scope = "workspace", scopeUserId = null } = params
    const embeddingLiteral = `[${embedding.join(",")}]`

    const result = await db.query<MemoRow & { distance: number }>(sql`
      WITH stream_memos AS (
        SELECT ${sql.raw(SELECT_FIELDS_PREFIXED)},
               m.embedding <=> ${embeddingLiteral}::vector AS distance
        FROM memos m
        JOIN conversations c ON m.source_conversation_id = c.id
        WHERE c.stream_id = ${streamId}
          AND m.workspace_id = ${workspaceId}
          AND m.status = 'active'
          AND m.scope = ${scope}
          AND m.scope_user_id IS NOT DISTINCT FROM ${scopeUserId}
          AND m.embedding IS NOT NULL
          AND m.embedding <=> ${embeddingLiteral}::vector < ${maxDistance}
        UNION
        SELECT ${sql.raw(SELECT_FIELDS_PREFIXED)},
               m.embedding <=> ${embeddingLiteral}::vector AS distance
        FROM memos m
        JOIN messages msg ON m.source_message_id = msg.id
        WHERE msg.stream_id = ${streamId}
          AND m.workspace_id = ${workspaceId}
          AND m.status = 'active'
          AND m.scope = ${scope}
          AND m.scope_user_id IS NOT DISTINCT FROM ${scopeUserId}
          AND m.embedding IS NOT NULL
          AND m.embedding <=> ${embeddingLiteral}::vector < ${maxDistance}
      )
      SELECT * FROM stream_memos
      ORDER BY distance ASC
      LIMIT 1
    `)

    const row = result.rows[0]
    if (!row) return null
    return { memo: mapRowToMemo(row), distance: row.distance }
  },

  /**
   * Active memos from ONE conversation near an embedding — the supersession
   * probe: a revised capture of a topic replaces the conversation's earlier
   * memo on that topic (see MEMO_SUPERSEDE_DISTANCE). `excludeIds` keeps memos
   * inserted earlier in the same batch from superseding each other. Ordered
   * nearest-first so the caller can link parentMemoId to the closest match.
   */
  async findSameConversationNear(
    db: Querier,
    params: {
      workspaceId: string
      conversationId: string
      embedding: number[]
      maxDistance: number
      excludeIds?: string[]
    }
  ): Promise<{ memo: Memo; distance: number }[]> {
    const embeddingLiteral = `[${params.embedding.join(",")}]`
    const result = await db.query<MemoRow & { distance: number }>(sql`
      SELECT ${sql.raw(SELECT_FIELDS_PREFIXED)},
             m.embedding <=> ${embeddingLiteral}::vector AS distance
      FROM memos m
      WHERE m.workspace_id = ${params.workspaceId}
        AND m.source_conversation_id = ${params.conversationId}
        AND m.status = 'active'
        AND m.embedding IS NOT NULL
        AND m.embedding <=> ${embeddingLiteral}::vector < ${params.maxDistance}
        AND m.id <> ALL(${params.excludeIds ?? []}::text[])
      ORDER BY distance ASC
    `)
    return result.rows.map((row) => ({ memo: mapRowToMemo(row), distance: row.distance }))
  },

  /** Mark memos superseded in one round-trip (INV-56). Workspace-scoped (INV-8). */
  async markSuperseded(db: Querier, workspaceId: string, ids: string[], revisionReason: string): Promise<void> {
    if (ids.length === 0) return
    await db.query(sql`
      UPDATE memos
      SET status = 'superseded', revision_reason = ${revisionReason}, updated_at = NOW()
      WHERE workspace_id = ${workspaceId} AND id = ANY(${ids}::text[]) AND status = 'active'
    `)
  },

  async insert(db: Querier, params: InsertMemoParams): Promise<Memo> {
    const result = await db.query<MemoRow>(sql`
      INSERT INTO memos (
        id, workspace_id, memo_type, source_message_id, source_conversation_id,
        title, abstract, key_points, search_config, source_message_ids, participant_ids,
        knowledge_type, tags, parent_memo_id, status, version,
        authored_by_kind, source_session_id, scope, scope_user_id
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
        ${detectSearchConfig(memoSearchText(params))},
        ${params.sourceMessageIds},
        ${params.participantIds},
        ${params.knowledgeType},
        ${params.tags ?? []},
        ${params.parentMemoId ?? null},
        ${params.status ?? "active"},
        ${params.version ?? 1},
        ${params.authoredByKind ?? "pipeline"},
        ${params.sourceSessionId ?? null},
        ${params.scope ?? "workspace"},
        ${params.scopeUserId ?? null}
      )
      RETURNING ${sql.raw(SELECT_FIELDS)}
    `)
    return mapRowToMemo(result.rows[0])
  },

  async update(db: Querier, workspaceId: string, id: string, params: UpdateMemoParams): Promise<Memo | null> {
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
    if (params.searchConfig !== undefined) {
      updates.push(`search_config = $${paramIndex++}`)
      values.push(params.searchConfig)
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
      const current = await db.query<MemoRow>(sql`
        SELECT ${sql.raw(SELECT_FIELDS)} FROM memos WHERE id = ${id} AND workspace_id = ${workspaceId}
      `)
      return current.rows[0] ? mapRowToMemo(current.rows[0]) : null
    }

    // Card ordering: every field update bumps the card version so a
    // memo:updated patch can never be repainted backwards by a raced,
    // pre-update edit payload (ms `updatedAt` ties; this cannot).
    updates.push(`card_version = card_version + 1`)
    updates.push(`updated_at = NOW()`)
    values.push(id, workspaceId)

    const query = `
      UPDATE memos
      SET ${updates.join(", ")}
      WHERE id = $${paramIndex} AND workspace_id = $${paramIndex + 1}
      RETURNING ${SELECT_FIELDS}
    `

    const result = await db.query<MemoRow>(query, values)
    if (!result.rows[0]) return null
    return mapRowToMemo(result.rows[0])
  },

  /** Rows whose config was set in the meantime (an edit re-detects) are left alone (INV-20). */
  async fillMissingSearchConfigs(
    db: Querier,
    workspaceId: string,
    rows: Array<{ id: string; searchConfig: string }>
  ): Promise<number> {
    if (rows.length === 0) return 0
    const result = await db.query(sql`
      UPDATE memos m
      SET search_config = v.search_config
      FROM UNNEST(${rows.map((row) => row.id)}::text[], ${rows.map((row) => row.searchConfig)}::text[]) AS v(id, search_config)
      WHERE m.id = v.id AND m.workspace_id = ${workspaceId} AND m.search_config IS NULL
    `)
    return result.rowCount ?? 0
  },

  async updateEmbedding(db: Querier, id: string, embedding: number[]): Promise<void> {
    await db.query(sql`
      UPDATE memos
      SET embedding = ${JSON.stringify(embedding)}::vector,
          updated_at = NOW()
      WHERE id = ${id}
    `)
  },

  /**
   * Archive an active memo. Guarded on `status = 'active'` so a `superseded`
   * memo can't be flipped to `archived` and then restored via `unarchive`
   * (which only accepts `status = 'archived'`) — that two-step would resurrect
   * retired-by-supersession content into retrieval. Returns null when the row
   * is missing or not active.
   */
  async archive(db: Querier, id: string): Promise<Memo | null> {
    const result = await db.query<MemoRow>(sql`
      UPDATE memos
      SET status = 'archived',
          archived_at = NOW(),
          updated_at = NOW()
      WHERE id = ${id} AND status = 'active'
      RETURNING ${sql.raw(SELECT_FIELDS)}
    `)
    if (!result.rows[0]) return null
    return mapRowToMemo(result.rows[0])
  },

  /**
   * Restore an archived memo to active. Guarded on `status = 'archived'` so a
   * `superseded` memo (retired because a newer capture replaced it) can never
   * be resurrected into retrieval — only user-archived memos come back.
   * Returns null when the row is missing or not archived.
   */
  async unarchive(db: Querier, id: string): Promise<Memo | null> {
    const result = await db.query<MemoRow>(sql`
      UPDATE memos
      SET status = 'active',
          archived_at = NULL,
          updated_at = NOW()
      WHERE id = ${id} AND status = 'archived'
      RETURNING ${sql.raw(SELECT_FIELDS)}
    `)
    if (!result.rows[0]) return null
    return mapRowToMemo(result.rows[0])
  },

  /**
   * Hard-delete a memo, workspace-scoped (INV-8). Used by the explorer's "forget
   * what you know about me" action on a user-scoped memo (roadmap 6.4) — unlike
   * archive this removes the row and its embedding outright. The caller is
   * responsible for the ownership gate; the `workspace_id` filter here is the
   * tenancy backstop. Returns true when a row was deleted.
   */
  async delete(db: Querier, workspaceId: string, id: string): Promise<boolean> {
    const result = await db.query(sql`
      DELETE FROM memos WHERE id = ${id} AND workspace_id = ${workspaceId}
    `)
    return (result.rowCount ?? 0) > 0
  },

  /** The active memo that superseded `memoId`, if any (reverse of parent_memo_id). */
  async findSupersededBy(db: Querier, workspaceId: string, memoId: string): Promise<Memo | null> {
    const result = await db.query<MemoRow>(sql`
      SELECT ${sql.raw(SELECT_FIELDS)}
      FROM memos
      WHERE workspace_id = ${workspaceId} AND parent_memo_id = ${memoId} AND status = 'active'
      ORDER BY created_at DESC
      LIMIT 1
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

  /** Semantic search over memo abstract embeddings by vector similarity. */
  async semanticSearch(db: Querier, params: SemanticSearchParams): Promise<MemoSearchResult[]> {
    const { workspaceId, embedding, filters, limit = 10, semanticDistanceThreshold = 0.8 } = params
    const streamIds = filters?.streamIds
    const hasStreamFilter = streamIds && streamIds.length > 0
    const hasMemoTypeFilter = Boolean(filters?.memoTypes?.length)
    const hasKnowledgeTypeFilter = Boolean(filters?.knowledgeTypes?.length)
    const hasTagFilter = Boolean(filters?.tags?.length)
    const scopeCond = scopeConditions(filters)

    const embeddingLiteral = `[${embedding.join(",")}]`

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
          AND (${!scopeCond.hasScopeFilter} OR m.scope = ${scopeCond.scope})
          AND (m.scope <> 'user' OR (${scopeCond.hasViewer} AND m.scope_user_id = ${scopeCond.viewerUserId}))
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

  /** Full-text search over memo title, abstract, and key points. */
  async fullTextSearch(db: Querier, params: FullTextSearchParams): Promise<MemoSearchResult[]> {
    const { workspaceId, query, filters, limit = 10 } = params
    const streamIds = filters?.streamIds
    const hasStreamFilter = streamIds && streamIds.length > 0
    const hasMemoTypeFilter = Boolean(filters?.memoTypes?.length)
    const hasKnowledgeTypeFilter = Boolean(filters?.knowledgeTypes?.length)
    const hasTagFilter = Boolean(filters?.tags?.length)
    const scopeCond = scopeConditions(filters)
    const statuses = filters?.statuses ?? DEFAULT_SEARCH_STATUSES

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
            AND m.status = ANY(${statuses})
            AND (${!hasMemoTypeFilter} OR m.memo_type = ANY(${filters?.memoTypes ?? []}))
            AND (${!hasKnowledgeTypeFilter} OR m.knowledge_type = ANY(${filters?.knowledgeTypes ?? []}))
            AND (${!hasTagFilter} OR m.tags && ${filters?.tags ?? []})
            AND (${!scopeCond.hasScopeFilter} OR m.scope = ${scopeCond.scope})
            AND (m.scope <> 'user' OR (${scopeCond.hasViewer} AND m.scope_user_id = ${scopeCond.viewerUserId}))
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

    // websearch_to_tsquery over plainto_tsquery for phrase support.
    const result = await db.query<MemoSearchRow & { rank: number }>(sql`
      WITH memo_with_stream AS (
        SELECT
          ${sql.raw(SELECT_FIELDS_PREFIXED)},
          ts_rank(${MEMO_TSVECTOR}, websearch_to_tsquery(${MEMO_ROW_CONFIG}, ${query})) as rank,
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
          AND m.status = ANY(${statuses})
          AND (${!hasMemoTypeFilter} OR m.memo_type = ANY(${filters?.memoTypes ?? []}))
          AND (${!hasKnowledgeTypeFilter} OR m.knowledge_type = ANY(${filters?.knowledgeTypes ?? []}))
          AND (${!hasTagFilter} OR m.tags && ${filters?.tags ?? []})
          AND (${!scopeCond.hasScopeFilter} OR m.scope = ${scopeCond.scope})
          AND (m.scope <> 'user' OR (${scopeCond.hasViewer} AND m.scope_user_id = ${scopeCond.viewerUserId}))
          AND (${filters?.before === undefined} OR m.created_at < ${filters?.before ?? new Date()})
          AND (${filters?.after === undefined} OR m.created_at >= ${filters?.after ?? new Date(0)})
          AND ${MEMO_TSVECTOR} @@ websearch_to_tsquery(${MEMO_ROW_CONFIG}, ${query})
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
    const scopeCond = scopeConditions(filters)
    const statuses = filters?.statuses ?? DEFAULT_SEARCH_STATUSES

    const embeddingLiteral = `[${embedding.join(",")}]`
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
            ORDER BY ts_rank(${MEMO_TSVECTOR}, websearch_to_tsquery(${MEMO_ROW_CONFIG}, ${query})) DESC
          ) as rank
        FROM memos m
        ${streamJoins}
        WHERE m.workspace_id = ${workspaceId}
          AND m.status = ANY(${statuses})
          AND (
            ${!hasStreamFilter}
            OR COALESCE(msg_stream.id, conv_stream.id) = ANY(${streamIds ?? []})
            OR root_stream.id = ANY(${streamIds ?? []})
          )
          AND (${!hasMemoTypeFilter} OR m.memo_type = ANY(${filters?.memoTypes ?? []}))
          AND (${!hasKnowledgeTypeFilter} OR m.knowledge_type = ANY(${filters?.knowledgeTypes ?? []}))
          AND (${!hasTagFilter} OR m.tags && ${filters?.tags ?? []})
          AND (${!scopeCond.hasScopeFilter} OR m.scope = ${scopeCond.scope})
          AND (m.scope <> 'user' OR (${scopeCond.hasViewer} AND m.scope_user_id = ${scopeCond.viewerUserId}))
          AND (${filters?.before === undefined} OR m.created_at < ${filters?.before ?? new Date()})
          AND (${filters?.after === undefined} OR m.created_at >= ${filters?.after ?? new Date(0)})
          AND ${MEMO_TSVECTOR} @@ websearch_to_tsquery(${MEMO_ROW_CONFIG}, ${query})
        LIMIT ${internalLimit}
      ),
      semantic_ranked AS (
        SELECT
          m.id,
          ROW_NUMBER() OVER (ORDER BY m.embedding <=> ${embeddingLiteral}::vector) as rank
        FROM memos m
        ${streamJoins}
        WHERE m.workspace_id = ${workspaceId}
          AND m.status = ANY(${statuses})
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
          AND (${!scopeCond.hasScopeFilter} OR m.scope = ${scopeCond.scope})
          AND (m.scope <> 'user' OR (${scopeCond.hasViewer} AND m.scope_user_id = ${scopeCond.viewerUserId}))
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
    const scopeCond = scopeConditions(filters)
    const statuses = filters?.statuses ?? DEFAULT_SEARCH_STATUSES

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
          AND m.status = ANY(${statuses})
          AND (${!hasMemoTypeFilter} OR m.memo_type = ANY(${filters?.memoTypes ?? []}))
          AND (${!hasKnowledgeTypeFilter} OR m.knowledge_type = ANY(${filters?.knowledgeTypes ?? []}))
          AND (${!hasTagFilter} OR m.tags && ${filters?.tags ?? []})
          AND (${!scopeCond.hasScopeFilter} OR m.scope = ${scopeCond.scope})
          AND (m.scope <> 'user' OR (${scopeCond.hasViewer} AND m.scope_user_id = ${scopeCond.viewerUserId}))
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
