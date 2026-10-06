import type { QueryConfig } from "pg"
import { composeSql, sql, type Querier } from "../../db"
import { roomReadableWithoutMembershipSql } from "../streams"
import { memoAudienceVisibleSql, type MemoAudience } from "./audience"
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

/** A trusted SQL text as a fragment `composeSql` splices (a bare `sql.raw` would be bound as a parameter). */
function rawSql(text: string): QueryConfig {
  return sql`${sql.raw(text)}`
}

/** Keeps only memos captured while `sharedRootStreamId` was shared; without one, filters nothing. */
function capturedWhileSharedSql(sharedRootStreamId: string | undefined, alias: string): QueryConfig {
  return sharedRootStreamId
    ? composeSql`AND ${rawSql(alias)}.shared_root_stream_id = ${sharedRootStreamId}`
    : rawSql("")
}

/**
 * FROM/WHERE of the memos a host's partner reads from its shared channel:
 * captured while shared, active, workspace-wide, from a conversation in
 * `streamIds`. Binds `m` to the memo and `c` to its conversation.
 */
function sharedFromChannelSql(workspaceId: string, sharedRootStreamId: string, streamIds: string[]): QueryConfig {
  return composeSql`
    FROM memos m
    JOIN conversations c ON c.id = m.source_conversation_id AND c.workspace_id = m.workspace_id
    WHERE m.workspace_id = ${workspaceId}
      AND m.shared_root_stream_id = ${sharedRootStreamId}
      AND m.status = 'active'
      AND m.scope = 'workspace'
      AND c.stream_id = ANY(${streamIds})
  `
}

/**
 * Memo full-text search computes its tsvector per row — no stored column, no
 * index — so both the vector and the query are stemmed with the config the row
 * itself was written in, rather than the OR-across-configs tsquery an
 * index-backed `search_vector` needs (`tsqueryAcrossConfigsSql`).
 */
const MEMO_TSVECTOR = rawSql(
  "to_tsvector(text_search_config(m.search_config), m.title || ' ' || m.abstract || ' ' || array_to_string(m.key_points, ' '))"
)
const MEMO_ROW_CONFIG = rawSql("text_search_config(m.search_config)")

/**
 * B2 structural boost expression, generated from the config maps (single
 * source of truth, INV-33). Emitted into the *outer* stage of hybrid
 * search only — the inner access-scoped CTEs are untouched, so the boost
 * can reorder but never widen visibility (§3.1). `m.knowledge_type` and
 * the resolved stream type are plain columns/expressions here; the values
 * are numeric literals from a typed constant, so raw interpolation is safe.
 */
function buildBoostExpression(apply: boolean): QueryConfig {
  if (!apply) return rawSql("1.0")

  const caseFor = (column: string, map: Record<string, number>): string => {
    const arms = Object.entries(map)
      .map(([key, factor]) => `WHEN '${key.replace(/'/g, "''")}' THEN ${Number(factor)}`)
      .join(" ")
    return `CASE ${column} ${arms} ELSE ${Number(MEMO_BOOST_DEFAULT)} END`
  }

  const knowledge = caseFor("m.knowledge_type", MEMO_KNOWLEDGE_TYPE_BOOST)
  const stream = caseFor("COALESCE(msg_stream.type, conv_stream.type)", MEMO_STREAM_TYPE_BOOST)
  const authorship = caseFor("m.authored_by_kind", MEMO_AUTHORED_BY_KIND_BOOST)
  return rawSql(`(${knowledge}) * (${stream}) * (${authorship})`)
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
  card_version: number
  revision_reason: string | null
  authored_by_kind: string
  source_session_id: string | null
  source_stream_ids: string[] | null
  requires_browse: boolean
  scope: string
  scope_user_id: string | null
  origin_workspace_id: string | null
  shared_root_stream_id: string | null
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
  /**
   * Bumped by every field update; the generation a reader pins before acting on
   * the memo (INV-66), and the version a shared channel's partner copies sync by.
   */
  cardVersion: number
  revisionReason: string | null
  authoredByKind: AuthoredByKind
  sourceSessionId: string | null
  /** Streams an agent-authored memo's content came from, as cited (threads stay threads); null when not recorded. */
  sourceStreamIds: string[] | null
  /** The agent wrote this memo for readers who browse the workspace, so only those readers see it. */
  requiresBrowse: boolean
  scope: MemoScope
  scopeUserId: string | null
  /** Set on a partner's read-only copy of a memo captured in a channel another workspace shares with it. */
  originWorkspaceId: string | null
  /** The shared channel this memo was captured from while shared; null when it never crossed. */
  sharedRootStreamId: string | null
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
  /** Streams an agent-authored memo's content came from; stored deduped and sorted. */
  sourceStreamIds?: string[]
  /** Hides the memo from readers who cannot browse the workspace; defaults to false. */
  requiresBrowse?: boolean
  /** Visibility tier (roadmap 6.4); defaults to `'workspace'`. */
  scope?: MemoScope
  /** Owner for `'user'` scope; must be set iff `scope === 'user'` (DB CHECK). */
  scopeUserId?: string | null
  /** The shared channel this memo was captured from while shared, read as its partner reads it. */
  sharedRootStreamId?: string
}

/** A host memo as its partner copies it. */
export interface MemoCopy {
  id: string
  conversationId: string
  title: string
  abstract: string
  keyPoints: string[]
  sourceMessageIds: string[]
  participantIds: string[]
  knowledgeType: KnowledgeType
  tags: string[]
  version: number
  cardVersion: number
  embedding: number[]
  createdAt: string
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
  /** Memos located in one of these streams or their threads; an empty list matches nothing. */
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
  /**
   * Who will read the results. Every audience must be able to read every stream an agent-authored
   * memo came from; omit it for a system caller that applies no such gate. Separate from `streamIds`,
   * which narrows by where a memo is located and may be narrowed further by the user.
   */
  audiences?: readonly MemoAudience[]
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
  /** `null` lets every embedded memo into the semantic leg, for callers that score the candidates themselves. */
  semanticDistanceThreshold?: number | null
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
    cardVersion: row.card_version,
    revisionReason: row.revision_reason,
    authoredByKind: row.authored_by_kind as AuthoredByKind,
    sourceSessionId: row.source_session_id,
    sourceStreamIds: row.source_stream_ids,
    requiresBrowse: row.requires_browse,
    scope: row.scope as MemoScope,
    scopeUserId: row.scope_user_id,
    originWorkspaceId: row.origin_workspace_id,
    sharedRootStreamId: row.shared_root_stream_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  }
}

const SELECT_FIELDS = `
  id, workspace_id, memo_type, source_message_id, source_conversation_id,
  title, abstract, key_points, source_message_ids, participant_ids,
  knowledge_type, tags, parent_memo_id, status, version, card_version, revision_reason,
  authored_by_kind, source_session_id, source_stream_ids, requires_browse, scope, scope_user_id,
  origin_workspace_id, shared_root_stream_id, created_at, updated_at, archived_at
`

const SELECT_FIELDS_PREFIXED = `
  m.id, m.workspace_id, m.memo_type, m.source_message_id, m.source_conversation_id,
  m.title, m.abstract, m.key_points, m.source_message_ids, m.participant_ids,
  m.knowledge_type, m.tags, m.parent_memo_id, m.status, m.version, m.card_version, m.revision_reason,
  m.authored_by_kind, m.source_session_id, m.source_stream_ids, m.requires_browse, m.scope, m.scope_user_id,
  m.origin_workspace_id, m.shared_root_stream_id, m.created_at, m.updated_at, m.archived_at
`
const SELECT_FIELDS_SQL = rawSql(SELECT_FIELDS)
const SELECT_FIELDS_PREFIXED_SQL = rawSql(SELECT_FIELDS_PREFIXED)

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
  async findById(db: Querier, workspaceId: string, id: string): Promise<Memo | null> {
    const result = await db.query<MemoRow>(sql`
      SELECT ${sql.raw(SELECT_FIELDS)} FROM memos WHERE id = ${id} AND workspace_id = ${workspaceId}
    `)
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

  /** The `ids` every audience may read (see {@link MemoAudience}); unknown and cross-workspace ids are dropped. */
  async filterVisibleIds(
    db: Querier,
    workspaceId: string,
    ids: readonly string[],
    audiences: readonly MemoAudience[]
  ): Promise<Set<string>> {
    if (ids.length === 0) return new Set()
    const result = await db.query<{ id: string }>(composeSql`
      SELECT m.id FROM memos m
      WHERE m.workspace_id = ${workspaceId}
        AND m.id = ANY(${ids as string[]}::text[])
        AND ${memoAudienceVisibleSql(workspaceId, audiences, "m")}
    `)
    return new Set(result.rows.map((row) => row.id))
  },

  /**
   * Card content for memos referenced by a message in `citingRootStreamId`,
   * for the payload that message ships on (INV-56: one batch, never per card).
   *
   * The access predicate is ROOM-UNIFORM, not per-viewer, because the payload
   * is delivered to a room: a summary is emitted only when every viewer of the
   * citing stream can open the memo. That means the memo's source stream
   * RESOLVED TO ITS ROOT is the citing root, or is readable by the whole room
   * (`roomReadableWithoutMembershipSql`: `guest_public`, or `public` when no
   * reader of the room lacks browse).
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
    const summaries = await this.findEmbedSummariesByRoot(
      db,
      workspaceId,
      memoIds.map((memoId) => ({ memoId, citingRootStreamId }))
    )
    return summaries.get(citingRootStreamId) ?? new Map()
  },

  async findEmbedSummariesByRoot(
    db: Querier,
    workspaceId: string,
    pairs: readonly { memoId: string; citingRootStreamId: string }[]
  ): Promise<Map<string, Map<string, MemoEmbedSummary>>> {
    if (pairs.length === 0) return new Map()
    const citingRoot = rawSql("requested.citing_root_stream_id")
    const result = await db.query<{
      citing_root_stream_id: string
      id: string
      title: string
      knowledge_type: string
      memo_type: string
      tags: string[]
      updated_at: Date
      card_version: number
    }>(composeSql`
      SELECT DISTINCT requested.citing_root_stream_id,
        m.id, m.title, m.knowledge_type, m.memo_type, m.tags, m.updated_at, m.card_version
      FROM unnest(
        ${pairs.map((pair) => pair.memoId)}::text[],
        ${pairs.map((pair) => pair.citingRootStreamId)}::text[]
      ) AS requested(memo_id, citing_root_stream_id)
      JOIN memos m ON m.id = requested.memo_id
      LEFT JOIN messages src_msg ON src_msg.id = m.source_message_id AND src_msg.workspace_id = m.workspace_id
      LEFT JOIN conversations src_conv ON src_conv.id = m.source_conversation_id
        AND src_conv.workspace_id = m.workspace_id
      LEFT JOIN messages first_msg ON first_msg.id = m.source_message_ids[1] AND first_msg.workspace_id = m.workspace_id
      LEFT JOIN streams s ON s.id = COALESCE(src_msg.stream_id, src_conv.stream_id, first_msg.stream_id)
        AND s.workspace_id = ${workspaceId}
      LEFT JOIN streams root ON root.id = COALESCE(s.root_stream_id, s.id)
        AND root.workspace_id = ${workspaceId}
      WHERE m.workspace_id = ${workspaceId}
        AND m.scope <> 'user'
        AND root.id IS NOT NULL
        AND (root.id = requested.citing_root_stream_id
          OR ${roomReadableWithoutMembershipSql(workspaceId, citingRoot, "root")})
        AND ${memoAudienceVisibleSql(workspaceId, [{ kind: "room", roomStreamId: citingRoot }], "m")}
    `)
    const summariesByRoot = new Map<string, Map<string, MemoEmbedSummary>>()
    for (const row of result.rows) {
      const summaries = summariesByRoot.get(row.citing_root_stream_id) ?? new Map<string, MemoEmbedSummary>()
      summaries.set(row.id, {
        memoId: row.id,
        title: row.title,
        knowledgeType: row.knowledge_type as KnowledgeType,
        memoType: row.memo_type as MemoType,
        tags: row.tags,
        updatedAt: row.updated_at.toISOString(),
        version: row.card_version,
      })
      summariesByRoot.set(row.citing_root_stream_id, summaries)
    }
    return summariesByRoot
  },

  /**
   * Streams whose live messages cite each of `memoIds`, so an update to a memo
   * can be pushed to exactly those rooms.
   *
   * Matches on the markdown pointer (`(memo:<id>)`), which every authored form
   * serializes to — the picker's node, a pasted link, an API-written body. The
   * id is a prefixed ULID, so the pattern cannot collide with a longer id, and
   * it is passed as a parameter rather than interpolated.
   */
  async findCitingStreamIds(
    db: Querier,
    workspaceId: string,
    memoIds: string[]
  ): Promise<Array<{ memoId: string; streamId: string }>> {
    if (memoIds.length === 0) return []
    const result = await db.query<{ memo_id: string; stream_id: string }>(sql`
      SELECT DISTINCT ids.memo_id, m.stream_id
      FROM unnest(${memoIds}::text[]) AS ids(memo_id)
      JOIN messages m
        ON m.workspace_id = ${workspaceId}
       AND m.deleted_at IS NULL
       AND m.content_markdown LIKE ('%(memo:' || ids.memo_id || ')%')
    `)
    return result.rows.map((row) => ({ memoId: row.memo_id, streamId: row.stream_id }))
  },

  /**
   * `scopeUserId` is the tier the reader writes into: private memos come back
   * only for their owner, null returns shared memos only. Only memos every
   * audience may read come back. `sharedRootStreamId` keeps only memos captured
   * while that channel was shared.
   */
  async findByStream(
    db: Querier,
    workspaceId: string,
    streamId: string,
    options: {
      scopeUserId: string | null
      audiences: readonly MemoAudience[]
      status?: MemoStatus
      limit?: number
      orderBy?: "createdAt" | "updatedAt"
      sharedRootStreamId?: string
    }
  ): Promise<Memo[]> {
    const orderBy = rawSql(options.orderBy === "updatedAt" ? "updated_at" : "created_at")
    const filters = composeSql`(m.scope <> 'user' OR m.scope_user_id = ${options.scopeUserId})
        ${options.status ? composeSql`AND m.status = ${options.status}` : rawSql("")}
        ${capturedWhileSharedSql(options.sharedRootStreamId, "m")}
        AND ${memoAudienceVisibleSql(workspaceId, options.audiences, "m")}`

    // UNION over the two source paths: conversation memos (via source_conversation_id)
    // and message memos (via source_message_id), each resolving to a stream_id.
    const result = await db.query<MemoRow>(composeSql`
      SELECT ${SELECT_FIELDS_PREFIXED_SQL} FROM memos m
      JOIN conversations c ON m.source_conversation_id = c.id AND c.workspace_id = m.workspace_id
      WHERE m.workspace_id = ${workspaceId} AND c.stream_id = ${streamId} AND ${filters}
      UNION
      SELECT ${SELECT_FIELDS_PREFIXED_SQL} FROM memos m
      JOIN messages msg ON m.source_message_id = msg.id AND msg.workspace_id = m.workspace_id
      WHERE m.workspace_id = ${workspaceId} AND msg.stream_id = ${streamId} AND ${filters}
      ORDER BY ${orderBy} DESC
      LIMIT ${options.limit ?? 50}
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

  /** Only memos every audience may read come back. */
  async findActiveBySourceConversation(
    db: Querier,
    workspaceId: string,
    conversationId: string,
    audiences: readonly MemoAudience[],
    sharedRootStreamId?: string
  ): Promise<Memo[]> {
    const result = await db.query<MemoRow>(composeSql`
      SELECT ${SELECT_FIELDS_SQL} FROM memos
      WHERE workspace_id = ${workspaceId} AND source_conversation_id = ${conversationId} AND status = 'active'
        ${capturedWhileSharedSql(sharedRootStreamId, "memos")}
        AND ${memoAudienceVisibleSql(workspaceId, audiences, "memos")}
      ORDER BY created_at ASC
    `)
    return result.rows.map(mapRowToMemo)
  },

  /**
   * Active saved and reflective memos the batch's audience may see that cite one
   * of `messageIds` edited after the memo was made: everything but private memos,
   * plus `scopeUserId`'s own when the batch is that owner's. A conversation
   * memo is reconsidered through its own conversation, so it is not returned here.
   * Only memos every audience may read come back.
   */
  async findActiveMessageMemosCitingEdited(
    db: Querier,
    workspaceId: string,
    messageIds: string[],
    scopeUserId: string | null,
    audiences: readonly MemoAudience[],
    sharedRootStreamId?: string
  ): Promise<Memo[]> {
    if (messageIds.length === 0) return []
    const result = await db.query<MemoRow>(composeSql`
      SELECT ${SELECT_FIELDS_SQL} FROM memos
      WHERE workspace_id = ${workspaceId}
        AND status = 'active'
        AND memo_type = 'message'
        AND (scope <> 'user' OR scope_user_id = ${scopeUserId})
        AND source_message_ids && ${messageIds}::text[]
        AND EXISTS (
          SELECT 1 FROM messages
          WHERE messages.workspace_id = memos.workspace_id
            AND messages.id = ANY(memos.source_message_ids)
            AND messages.id = ANY(${messageIds}::text[])
            AND messages.edited_at > memos.created_at
        )
        AND ${memoAudienceVisibleSql(workspaceId, audiences, "memos")}
        ${capturedWhileSharedSql(sharedRootStreamId, "memos")}
      ORDER BY created_at ASC
    `)
    return result.rows.map(mapRowToMemo)
  },

  /**
   * Serializes, per top-level stream, memo saves (batch, save_memo, reflective
   * capture) with each other and with retirement when a source message is
   * deleted. Keyed by the root so a save in a thread and a deletion in its
   * channel take the same lock.
   */
  async lockStreamSaves(db: Querier, rootStreamId: string): Promise<void> {
    await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`memo-batch:${rootStreamId}`])
  },

  /** Active memos citing `messageId`, each flagged with whether any of its sources is still undeleted. */
  async findActiveCitingMessage(
    db: Querier,
    workspaceId: string,
    messageId: string
  ): Promise<Array<{ memo: Memo; hasLiveSource: boolean }>> {
    const result = await db.query<MemoRow & { has_live_source: boolean }>(sql`
      SELECT ${sql.raw(SELECT_FIELDS)},
        EXISTS (
          SELECT 1 FROM messages
          JOIN streams ON streams.id = messages.stream_id AND streams.workspace_id = memos.workspace_id
          WHERE messages.id = ANY(memos.source_message_ids)
            AND messages.workspace_id = memos.workspace_id
            AND messages.deleted_at IS NULL
        ) AS has_live_source
      FROM memos
      WHERE workspace_id = ${workspaceId}
        AND status = 'active'
        AND source_message_ids @> ARRAY[${messageId}]::text[]
    `)
    return result.rows.map((row) => ({ memo: mapRowToMemo(row), hasLiveSource: row.has_live_source }))
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
      /** Only memos every audience may read count as duplicates, so a save never resolves to a memo its writer's readers cannot open. */
      audiences: readonly MemoAudience[]
      /** Only memos captured while this channel was shared block the candidate. */
      sharedRootStreamId?: string
    }
  ): Promise<{ memo: Memo; distance: number } | null> {
    const { workspaceId, streamId, embedding, maxDistance, scope = "workspace", scopeUserId = null, audiences } = params
    const embeddingLiteral = `[${embedding.join(",")}]`
    const audienceVisible = memoAudienceVisibleSql(workspaceId, audiences, "m")
    const sharedOnly = capturedWhileSharedSql(params.sharedRootStreamId, "m")

    const result = await db.query<MemoRow & { distance: number }>(composeSql`
      WITH stream_memos AS (
        SELECT ${SELECT_FIELDS_PREFIXED_SQL},
               m.embedding <=> ${embeddingLiteral}::vector AS distance
        FROM memos m
        JOIN conversations c ON m.source_conversation_id = c.id AND c.workspace_id = m.workspace_id
        WHERE c.stream_id = ${streamId}
          AND m.workspace_id = ${workspaceId}
          AND m.status = 'active'
          AND m.scope = ${scope}
          AND m.scope_user_id IS NOT DISTINCT FROM ${scopeUserId}
          ${sharedOnly}
          AND m.embedding IS NOT NULL
          AND m.embedding <=> ${embeddingLiteral}::vector < ${maxDistance}
          AND ${audienceVisible}
        UNION
        SELECT ${SELECT_FIELDS_PREFIXED_SQL},
               m.embedding <=> ${embeddingLiteral}::vector AS distance
        FROM memos m
        JOIN messages msg ON m.source_message_id = msg.id AND msg.workspace_id = m.workspace_id
        WHERE msg.stream_id = ${streamId}
          AND m.workspace_id = ${workspaceId}
          AND m.status = 'active'
          AND m.scope = ${scope}
          AND m.scope_user_id IS NOT DISTINCT FROM ${scopeUserId}
          ${sharedOnly}
          AND m.embedding IS NOT NULL
          AND m.embedding <=> ${embeddingLiteral}::vector < ${maxDistance}
          AND ${audienceVisible}
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

  /**
   * The `ids` a candidate memo may retire, in input order: those from its own
   * conversation, and those whose newest source message is no newer than the
   * candidate's newest. A re-run of an older conversation can contradict a
   * memo that already reversed it; without this it would retire the newer
   * conclusion. Compares `created_at`, not `edited_at`, so a typo fix can't
   * make old knowledge look new.
   */
  async filterSupersedable(
    db: Querier,
    workspaceId: string,
    ids: string[],
    candidate: { conversationId: string | null; sourceMessageIds: string[] }
  ): Promise<string[]> {
    if (ids.length === 0) return []
    const result = await db.query<{ id: string }>(sql`
      SELECT m.id
      FROM memos m
      WHERE m.workspace_id = ${workspaceId}
        AND m.id = ANY(${ids}::text[])
        AND (
          m.source_conversation_id = ${candidate.conversationId}
          OR (
            SELECT max(msg.created_at)
            FROM messages msg
            WHERE msg.workspace_id = m.workspace_id
              AND msg.id = ANY(array_append(m.source_message_ids, m.source_message_id))
          ) <= (
            SELECT max(msg.created_at)
            FROM messages msg
            WHERE msg.workspace_id = m.workspace_id AND msg.id = ANY(${candidate.sourceMessageIds}::text[])
          )
        )
    `)
    const allowed = new Set(result.rows.map((row) => row.id))
    return ids.filter((id) => allowed.has(id))
  },

  /**
   * Row-locks the memos and returns their current card versions, so a caller
   * can compare against the versions it observed and act before any edit
   * lands (INV-20). Locked in id order so concurrent lockers can't deadlock.
   */
  async lockCardVersions(db: Querier, workspaceId: string, ids: string[]): Promise<Map<string, number>> {
    if (ids.length === 0) return new Map()
    const result = await db.query<{ id: string; card_version: number }>(sql`
      SELECT id, card_version FROM memos
      WHERE workspace_id = ${workspaceId} AND id = ANY(${ids}::text[])
      ORDER BY id
      FOR UPDATE
    `)
    return new Map(result.rows.map((row) => [row.id, row.card_version]))
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

  /** Archive active memos in one round-trip (INV-56). Workspace-scoped (INV-8). */
  async archiveMany(db: Querier, workspaceId: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return
    await db.query(sql`
      UPDATE memos
      SET status = 'archived', archived_at = NOW(), updated_at = NOW()
      WHERE workspace_id = ${workspaceId} AND id = ANY(${ids}::text[]) AND status = 'active'
    `)
  },

  async insert(db: Querier, params: InsertMemoParams): Promise<Memo> {
    const result = await db.query<MemoRow>(sql`
      INSERT INTO memos (
        id, workspace_id, memo_type, source_message_id, source_conversation_id,
        title, abstract, key_points, search_config, source_message_ids, participant_ids,
        knowledge_type, tags, parent_memo_id, status, version,
        authored_by_kind, source_session_id, source_stream_ids, requires_browse, scope, scope_user_id,
        shared_root_stream_id
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
        ${params.sourceStreamIds ? [...new Set(params.sourceStreamIds)].sort() : null},
        ${params.requiresBrowse ?? false},
        ${params.scope ?? "workspace"},
        ${params.scopeUserId ?? null},
        ${params.sharedRootStreamId ?? null}
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

  async updateEmbedding(db: Querier, workspaceId: string, id: string, embedding: number[]): Promise<void> {
    await db.query(sql`
      UPDATE memos
      SET embedding = ${JSON.stringify(embedding)}::vector,
          updated_at = NOW()
      WHERE id = ${id} AND workspace_id = ${workspaceId}
    `)
  },

  /** The memos a host's partner reads from its shared channel (`sharedFromChannelSql`). */
  async listSharedVersions(
    db: Querier,
    workspaceId: string,
    sharedRootStreamId: string,
    streamIds: string[]
  ): Promise<Array<{ id: string; cardVersion: number }>> {
    const result = await db.query<{ id: string; card_version: number }>(composeSql`
      SELECT m.id, m.card_version
      ${sharedFromChannelSql(workspaceId, sharedRootStreamId, streamIds)}
      ORDER BY m.id
    `)
    return result.rows.map((row) => ({ id: row.id, cardVersion: row.card_version }))
  },

  /** `listSharedVersions`'s memos among `ids`, each with its conversation's stream and its embedding. */
  async findSharedWithEmbeddings(
    db: Querier,
    workspaceId: string,
    sharedRootStreamId: string,
    streamIds: string[],
    ids: string[]
  ): Promise<Array<{ memo: Memo; conversationId: string; streamId: string; embedding: number[] | null }>> {
    const result = await db.query<MemoRow & { conversation_id: string; stream_id: string; embedding: string | null }>(
      composeSql`
      SELECT ${SELECT_FIELDS_PREFIXED_SQL}, c.id AS conversation_id, c.stream_id, m.embedding::text AS embedding
      ${sharedFromChannelSql(workspaceId, sharedRootStreamId, streamIds)}
        AND m.id = ANY(${ids})
      ORDER BY m.id
    `
    )
    return result.rows.map((row) => ({
      memo: mapRowToMemo(row),
      conversationId: row.conversation_id,
      streamId: row.stream_id,
      embedding: row.embedding === null ? null : (JSON.parse(row.embedding) as number[]),
    }))
  },

  /** The copies a partner holds of the memos `originWorkspaceId` captured from its shared channel. */
  async listCopyVersions(
    db: Querier,
    workspaceId: string,
    originWorkspaceId: string,
    sharedRootStreamId: string
  ): Promise<Array<{ id: string; cardVersion: number }>> {
    const result = await db.query<{ id: string; card_version: number }>(sql`
      SELECT id, card_version FROM memos
      WHERE workspace_id = ${workspaceId}
        AND origin_workspace_id = ${originWorkspaceId}
        AND shared_root_stream_id = ${sharedRootStreamId}
      ORDER BY id
    `)
    return result.rows.map((row) => ({ id: row.id, cardVersion: row.card_version }))
  },

  /**
   * Writes a partner's copies of memos its host captured from a shared channel,
   * under the host's ids. A copy only moves forward: a row already at the
   * host's `cardVersion`, or one that is not this channel's copy, is left as it
   * is. Returns the ids it inserted and the ids it updated.
   */
  async upsertCopies(
    db: Querier,
    workspaceId: string,
    originWorkspaceId: string,
    sharedRootStreamId: string,
    copies: MemoCopy[]
  ): Promise<{ inserted: string[]; updated: string[] }> {
    if (copies.length === 0) return { inserted: [], updated: [] }
    const rows = copies.map((copy) => ({
      id: copy.id,
      conversation_id: copy.conversationId,
      title: copy.title,
      abstract: copy.abstract,
      key_points: copy.keyPoints,
      search_config: detectSearchConfig(memoSearchText(copy)),
      source_message_ids: copy.sourceMessageIds,
      participant_ids: copy.participantIds,
      knowledge_type: copy.knowledgeType,
      tags: copy.tags,
      version: copy.version,
      card_version: copy.cardVersion,
      embedding: JSON.stringify(copy.embedding),
      created_at: copy.createdAt,
    }))
    const result = await db.query<{ id: string; inserted: boolean }>(sql`
      INSERT INTO memos (
        id, workspace_id, memo_type, source_conversation_id,
        title, abstract, key_points, search_config, source_message_ids, participant_ids,
        knowledge_type, tags, status, version, card_version, authored_by_kind, scope,
        shared_root_stream_id, origin_workspace_id, embedding, created_at
      )
      SELECT
        x.id, ${workspaceId}, 'conversation', x.conversation_id,
        x.title, x.abstract, ARRAY(SELECT jsonb_array_elements_text(x.key_points)), x.search_config,
        ARRAY(SELECT jsonb_array_elements_text(x.source_message_ids)),
        ARRAY(SELECT jsonb_array_elements_text(x.participant_ids)),
        x.knowledge_type, ARRAY(SELECT jsonb_array_elements_text(x.tags)), 'active', x.version, x.card_version,
        'pipeline', 'workspace', ${sharedRootStreamId}, ${originWorkspaceId}, x.embedding::vector, x.created_at
      FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS x(
        id text, conversation_id text, title text, abstract text, key_points jsonb, search_config text,
        source_message_ids jsonb, participant_ids jsonb, knowledge_type text, tags jsonb,
        version int, card_version int, embedding text, created_at timestamptz
      )
      ON CONFLICT (workspace_id, id) DO UPDATE SET
        source_conversation_id = EXCLUDED.source_conversation_id,
        title = EXCLUDED.title,
        abstract = EXCLUDED.abstract,
        key_points = EXCLUDED.key_points,
        search_config = EXCLUDED.search_config,
        source_message_ids = EXCLUDED.source_message_ids,
        participant_ids = EXCLUDED.participant_ids,
        knowledge_type = EXCLUDED.knowledge_type,
        tags = EXCLUDED.tags,
        version = EXCLUDED.version,
        card_version = EXCLUDED.card_version,
        embedding = EXCLUDED.embedding,
        updated_at = NOW()
      WHERE memos.origin_workspace_id = EXCLUDED.origin_workspace_id
        AND memos.shared_root_stream_id = EXCLUDED.shared_root_stream_id
        AND memos.card_version < EXCLUDED.card_version
      RETURNING id, (xmax = 0) AS inserted
    `)
    return {
      inserted: result.rows.filter((row) => row.inserted).map((row) => row.id),
      updated: result.rows.filter((row) => !row.inserted).map((row) => row.id),
    }
  },

  /** Deletes a partner's copies, each only while it is still at the `cardVersion` the caller saw. */
  async deleteCopies(
    db: Querier,
    workspaceId: string,
    originWorkspaceId: string,
    copies: Array<{ id: string; cardVersion: number }>
  ): Promise<string[]> {
    if (copies.length === 0) return []
    const result = await db.query<{ id: string }>(sql`
      DELETE FROM memos m
      USING UNNEST(${copies.map((copy) => copy.id)}::text[], ${copies.map((copy) => copy.cardVersion)}::int[])
        AS v(id, card_version)
      WHERE m.workspace_id = ${workspaceId}
        AND m.origin_workspace_id = ${originWorkspaceId}
        AND m.id = v.id
        AND m.card_version = v.card_version
      RETURNING m.id
    `)
    return result.rows.map((row) => row.id)
  },

  /**
   * Archive an active memo. Guarded on `status = 'active'` so a `superseded`
   * memo can't be flipped to `archived` and then restored via `unarchive`
   * (which only accepts `status = 'archived'`) — that two-step would resurrect
   * retired-by-supersession content into retrieval. Returns null when the row
   * is missing or not active.
   */
  async archive(db: Querier, workspaceId: string, id: string): Promise<Memo | null> {
    const result = await db.query<MemoRow>(sql`
      UPDATE memos
      SET status = 'archived',
          archived_at = NOW(),
          updated_at = NOW()
      WHERE id = ${id} AND workspace_id = ${workspaceId} AND status = 'active'
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
  async unarchive(db: Querier, workspaceId: string, id: string): Promise<Memo | null> {
    const result = await db.query<MemoRow>(sql`
      UPDATE memos
      SET status = 'active',
          archived_at = NULL,
          updated_at = NOW()
      WHERE id = ${id} AND workspace_id = ${workspaceId} AND status = 'archived'
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

  /**
   * Tags a capture into `rootStreamId` may show its model: shared memos whose
   * source root is that root or readable by its whole room (resolved through the
   * root, as `findEmbedSummaries` does), plus `scopeUserId`'s own private memos.
   * With `sharedRootStreamId`, only memos captured while that channel was shared.
   */
  async getAllTags(
    db: Querier,
    workspaceId: string,
    scope: { scopeUserId: string | null; rootStreamId: string; sharedRootStreamId?: string }
  ): Promise<string[]> {
    const result = await db.query<{ tag: string }>(composeSql`
      SELECT DISTINCT unnest(m.tags) as tag
      FROM memos m
      LEFT JOIN messages src_msg ON src_msg.id = m.source_message_id AND src_msg.workspace_id = m.workspace_id
      LEFT JOIN conversations src_conv ON src_conv.id = m.source_conversation_id
        AND src_conv.workspace_id = m.workspace_id
      LEFT JOIN messages first_msg ON first_msg.id = m.source_message_ids[1] AND first_msg.workspace_id = m.workspace_id
      LEFT JOIN streams s ON s.id = COALESCE(src_msg.stream_id, src_conv.stream_id, first_msg.stream_id)
        AND s.workspace_id = m.workspace_id
      LEFT JOIN streams root ON root.id = COALESCE(s.root_stream_id, s.id) AND root.workspace_id = s.workspace_id
      WHERE m.workspace_id = ${workspaceId} AND m.status = 'active'
        ${capturedWhileSharedSql(scope.sharedRootStreamId, "m")}
        AND (
          (m.scope = 'user' AND m.scope_user_id = ${scope.scopeUserId})
          OR (m.scope <> 'user' AND (
            root.id = ${scope.rootStreamId}
            OR ${roomReadableWithoutMembershipSql(workspaceId, scope.rootStreamId, "root")}
          ) AND ${memoAudienceVisibleSql(workspaceId, [{ kind: "room", roomStreamId: scope.rootStreamId }], "m")})
        )
      ORDER BY tag
    `)
    return result.rows.map((r) => r.tag)
  },

  /** Full-text search over memo title, abstract, and key points. */
  async fullTextSearch(db: Querier, params: FullTextSearchParams): Promise<MemoSearchResult[]> {
    const { workspaceId, query, filters, limit = 10 } = params
    const streamIds = filters?.streamIds
    const hasStreamFilter = streamIds !== undefined
    const hasMemoTypeFilter = Boolean(filters?.memoTypes?.length)
    const hasKnowledgeTypeFilter = Boolean(filters?.knowledgeTypes?.length)
    const hasTagFilter = Boolean(filters?.tags?.length)
    const scopeCond = scopeConditions(filters)
    const statuses = filters?.statuses ?? DEFAULT_SEARCH_STATUSES
    const audienceVisible = memoAudienceVisibleSql(workspaceId, filters?.audiences ?? [], "m")

    if (!query.trim()) {
      const result = await db.query<MemoSearchRow>(composeSql`
        WITH memo_with_stream AS (
          SELECT
            ${SELECT_FIELDS_PREFIXED_SQL},
            COALESCE(msg_stream.id, conv_stream.id) as stream_id,
            COALESCE(msg_stream.type, conv_stream.type) as stream_type,
            COALESCE(msg_stream.display_name, msg_stream.slug, conv_stream.display_name, conv_stream.slug) as stream_name,
            root_stream.id as root_stream_id,
            root_stream.type as root_stream_type,
            COALESCE(root_stream.display_name, root_stream.slug) as root_stream_name
          FROM memos m
          LEFT JOIN messages msg ON m.source_message_id = msg.id AND msg.workspace_id = m.workspace_id
          LEFT JOIN streams msg_stream ON msg.stream_id = msg_stream.id AND msg_stream.workspace_id = m.workspace_id
          LEFT JOIN conversations conv ON m.source_conversation_id = conv.id AND conv.workspace_id = m.workspace_id
          LEFT JOIN streams conv_stream ON conv.stream_id = conv_stream.id AND conv_stream.workspace_id = m.workspace_id
          LEFT JOIN streams root_stream ON root_stream.id = COALESCE(msg_stream.root_stream_id, conv_stream.root_stream_id)
            AND root_stream.workspace_id = m.workspace_id
          WHERE m.workspace_id = ${workspaceId}
            AND m.status = ANY(${statuses})
            AND (${!hasMemoTypeFilter} OR m.memo_type = ANY(${filters?.memoTypes ?? []}))
            AND (${!hasKnowledgeTypeFilter} OR m.knowledge_type = ANY(${filters?.knowledgeTypes ?? []}))
            AND (${!hasTagFilter} OR m.tags && ${filters?.tags ?? []})
            AND (${!scopeCond.hasScopeFilter} OR m.scope = ${scopeCond.scope})
            AND (m.scope <> 'user' OR (${scopeCond.hasViewer} AND m.scope_user_id = ${scopeCond.viewerUserId}))
            AND (${filters?.before === undefined} OR m.created_at < ${filters?.before ?? new Date()})
            AND (${filters?.after === undefined} OR m.created_at >= ${filters?.after ?? new Date(0)})
            AND ${audienceVisible}
        )
        SELECT * FROM memo_with_stream
        WHERE (${!hasStreamFilter} OR stream_id = ANY(${streamIds ?? []}) OR root_stream_id = ANY(${streamIds ?? []}))
        ORDER BY updated_at DESC
        LIMIT ${limit}
      `)

      return result.rows.map((row) => mapMemoSearchResult(row, 0))
    }

    // websearch_to_tsquery over plainto_tsquery for phrase support.
    const result = await db.query<MemoSearchRow & { rank: number }>(composeSql`
      WITH memo_with_stream AS (
        SELECT
          ${SELECT_FIELDS_PREFIXED_SQL},
          ts_rank(${MEMO_TSVECTOR}, websearch_to_tsquery(${MEMO_ROW_CONFIG}, ${query})) as rank,
          COALESCE(msg_stream.id, conv_stream.id) as stream_id,
          COALESCE(msg_stream.type, conv_stream.type) as stream_type,
          COALESCE(msg_stream.display_name, msg_stream.slug, conv_stream.display_name, conv_stream.slug) as stream_name,
          root_stream.id as root_stream_id,
          root_stream.type as root_stream_type,
          COALESCE(root_stream.display_name, root_stream.slug) as root_stream_name
        FROM memos m
        LEFT JOIN messages msg ON m.source_message_id = msg.id AND msg.workspace_id = m.workspace_id
        LEFT JOIN streams msg_stream ON msg.stream_id = msg_stream.id AND msg_stream.workspace_id = m.workspace_id
        LEFT JOIN conversations conv ON m.source_conversation_id = conv.id AND conv.workspace_id = m.workspace_id
        LEFT JOIN streams conv_stream ON conv.stream_id = conv_stream.id AND conv_stream.workspace_id = m.workspace_id
        LEFT JOIN streams root_stream ON root_stream.id = COALESCE(msg_stream.root_stream_id, conv_stream.root_stream_id)
          AND root_stream.workspace_id = m.workspace_id
        WHERE m.workspace_id = ${workspaceId}
          AND m.status = ANY(${statuses})
          AND (${!hasMemoTypeFilter} OR m.memo_type = ANY(${filters?.memoTypes ?? []}))
          AND (${!hasKnowledgeTypeFilter} OR m.knowledge_type = ANY(${filters?.knowledgeTypes ?? []}))
          AND (${!hasTagFilter} OR m.tags && ${filters?.tags ?? []})
          AND (${!scopeCond.hasScopeFilter} OR m.scope = ${scopeCond.scope})
          AND (m.scope <> 'user' OR (${scopeCond.hasViewer} AND m.scope_user_id = ${scopeCond.viewerUserId}))
          AND (${filters?.before === undefined} OR m.created_at < ${filters?.before ?? new Date()})
          AND (${filters?.after === undefined} OR m.created_at >= ${filters?.after ?? new Date(0)})
          AND ${audienceVisible}
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
    const hasStreamFilter = streamIds !== undefined
    const hasMemoTypeFilter = Boolean(filters?.memoTypes?.length)
    const hasKnowledgeTypeFilter = Boolean(filters?.knowledgeTypes?.length)
    const hasTagFilter = Boolean(filters?.tags?.length)
    const scopeCond = scopeConditions(filters)
    const statuses = filters?.statuses ?? DEFAULT_SEARCH_STATUSES
    const audienceVisible = memoAudienceVisibleSql(workspaceId, filters?.audiences ?? [], "m")

    const embeddingLiteral = `[${embedding.join(",")}]`
    const streamJoins = rawSql(`
      LEFT JOIN messages msg ON m.source_message_id = msg.id AND msg.workspace_id = m.workspace_id
      LEFT JOIN streams msg_stream ON msg.stream_id = msg_stream.id AND msg_stream.workspace_id = m.workspace_id
      LEFT JOIN conversations conv ON m.source_conversation_id = conv.id AND conv.workspace_id = m.workspace_id
      LEFT JOIN streams conv_stream ON conv.stream_id = conv_stream.id AND conv_stream.workspace_id = m.workspace_id
      LEFT JOIN streams root_stream ON root_stream.id = COALESCE(msg_stream.root_stream_id, conv_stream.root_stream_id)
        AND root_stream.workspace_id = m.workspace_id
    `)

    // Per-list candidate cap before fusion. The 50 floor matches the
    // message hybrid path; widen to the requested pool so a larger
    // configured candidate pool is actually filled before rerank/trim.
    const internalLimit = Math.max(limit, 50)

    // B2: structural boost, applied only in the outer hydrate stage.
    const boost = buildBoostExpression(applyStructuralBoost)

    const result = await db.query<MemoSearchRow & { score: number }>(composeSql`
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
          AND ${audienceVisible}
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
          AND (${semanticDistanceThreshold === null} OR m.embedding <=> ${embeddingLiteral}::vector < ${semanticDistanceThreshold ?? 0})
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
          AND ${audienceVisible}
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
        ${SELECT_FIELDS_PREFIXED_SQL},
        (f.score * ${boost}) as score,
        COALESCE(msg_stream.id, conv_stream.id) as stream_id,
        COALESCE(msg_stream.type, conv_stream.type) as stream_type,
        COALESCE(msg_stream.display_name, msg_stream.slug, conv_stream.display_name, conv_stream.slug) as stream_name,
        root_stream.id as root_stream_id,
        root_stream.type as root_stream_type,
        COALESCE(root_stream.display_name, root_stream.slug) as root_stream_name
      FROM fused f
      JOIN memos m ON m.id = f.id AND m.workspace_id = ${workspaceId}
      ${streamJoins}
      ORDER BY (f.score * ${boost}) DESC
      LIMIT ${limit}
    `)

    return result.rows.map((row) => mapMemoSearchResult(row, 1 / (1 + row.score)))
  },

  async exactSearch(db: Querier, params: FullTextSearchParams): Promise<MemoSearchResult[]> {
    const { workspaceId, query, filters, limit = 10 } = params
    const streamIds = filters?.streamIds
    const hasStreamFilter = streamIds !== undefined
    const hasMemoTypeFilter = Boolean(filters?.memoTypes?.length)
    const hasKnowledgeTypeFilter = Boolean(filters?.knowledgeTypes?.length)
    const hasTagFilter = Boolean(filters?.tags?.length)
    const scopeCond = scopeConditions(filters)
    const statuses = filters?.statuses ?? DEFAULT_SEARCH_STATUSES
    const audienceVisible = memoAudienceVisibleSql(workspaceId, filters?.audiences ?? [], "m")

    if (!query.trim()) {
      return this.fullTextSearch(db, { workspaceId, query, filters, limit })
    }

    const escapedQuery = query.replace(/[%_\\]/g, "\\$&")

    const result = await db.query<MemoSearchRow>(composeSql`
      WITH memo_with_stream AS (
        SELECT
          ${SELECT_FIELDS_PREFIXED_SQL},
          COALESCE(msg_stream.id, conv_stream.id) as stream_id,
          COALESCE(msg_stream.type, conv_stream.type) as stream_type,
          COALESCE(msg_stream.display_name, msg_stream.slug, conv_stream.display_name, conv_stream.slug) as stream_name,
          root_stream.id as root_stream_id,
          root_stream.type as root_stream_type,
          COALESCE(root_stream.display_name, root_stream.slug) as root_stream_name
        FROM memos m
        LEFT JOIN messages msg ON m.source_message_id = msg.id AND msg.workspace_id = m.workspace_id
        LEFT JOIN streams msg_stream ON msg.stream_id = msg_stream.id AND msg_stream.workspace_id = m.workspace_id
        LEFT JOIN conversations conv ON m.source_conversation_id = conv.id AND conv.workspace_id = m.workspace_id
        LEFT JOIN streams conv_stream ON conv.stream_id = conv_stream.id AND conv_stream.workspace_id = m.workspace_id
        LEFT JOIN streams root_stream ON root_stream.id = COALESCE(msg_stream.root_stream_id, conv_stream.root_stream_id)
          AND root_stream.workspace_id = m.workspace_id
        WHERE m.workspace_id = ${workspaceId}
          AND m.status = ANY(${statuses})
          AND (${!hasMemoTypeFilter} OR m.memo_type = ANY(${filters?.memoTypes ?? []}))
          AND (${!hasKnowledgeTypeFilter} OR m.knowledge_type = ANY(${filters?.knowledgeTypes ?? []}))
          AND (${!hasTagFilter} OR m.tags && ${filters?.tags ?? []})
          AND (${!scopeCond.hasScopeFilter} OR m.scope = ${scopeCond.scope})
          AND (m.scope <> 'user' OR (${scopeCond.hasViewer} AND m.scope_user_id = ${scopeCond.viewerUserId}))
          AND (${filters?.before === undefined} OR m.created_at < ${filters?.before ?? new Date()})
          AND (${filters?.after === undefined} OR m.created_at >= ${filters?.after ?? new Date(0)})
          AND ${audienceVisible}
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
