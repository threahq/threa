import { sql, composeSql, type Querier } from "../../db"
import { streamAccessPredicateSql } from "../streams"
import {
  ActivityTypes,
  ConversationStatuses,
  LabelableResourceTypes,
  type ConversationStatus,
  type BoardLens,
} from "@threa/types"

/**
 * The board-lens WHERE fragment — the SQL half of the seed/pagination filter,
 * kept in lockstep with `matchesBoardLens` (the client's read-side predicate) so
 * a page can't return rows the client then hides. `all`, absent, and any retired
 * lens value still stored on a saved view add nothing — the fragment degrades to
 * the default home, which shows everything.
 */
function boardLensCondSql(lens: BoardLens | undefined, userId: string) {
  if (lens === "mine") {
    // The viewer's own conversations: authored/participating (`participant_ids`,
    // GIN-indexed) OR `@`-mentioned on a primary message (`user_activity`,
    // index-backed). Pinned to `conversations.message_ids` — the SAME set the JS
    // half folds over in `buildBoardPosts` — so the seed boundary and the
    // client's `isMine` render authority can't disagree. Workspace-scoped inside
    // the EXISTS (INV-8); `ActivityTypes.MENTION`, not a literal (INV-33).
    return composeSql`AND (
      participant_ids @> ARRAY[${userId}]::text[]
      OR EXISTS (
        SELECT 1 FROM user_activity ua
        WHERE ua.workspace_id = conversations.workspace_id
          AND ua.user_id = ${userId}
          AND ua.activity_type = ${ActivityTypes.MENTION}
          AND ua.message_id = ANY(conversations.message_ids)
      )
    )`
  }
  if (lens === "decisions") {
    // Workspace-scoped (INV-8) and active-only, matching
    // `MemoRepository.findConversationIdsWithMemos` and the file's
    // `findActiveBySourceConversation` — an archived/superseded memo is no longer
    // captured knowledge, so it must drop the conversation from the lens.
    return composeSql`AND EXISTS (
      SELECT 1 FROM memos
      WHERE memos.source_conversation_id = conversations.id
        AND memos.workspace_id = conversations.workspace_id
        AND memos.status = 'active'
    )`
  }
  return sql``
}

/**
 * The board's stream-scope WHERE fragment. Scope matches by effective ROOT
 * (`COALESCE(root_stream_id, id)` — the same rule as `streamAccessPredicateSql`),
 * so scoping to a channel keeps conversations anchored in threads under it; a
 * conversation never falls out of its channel's scope just because it lives in
 * a thread. Workspace-scoped inside the EXISTS (INV-8).
 */
function boardScopeCondSql(scopeStreamIds: string[] | undefined) {
  if (!scopeStreamIds || scopeStreamIds.length === 0) return sql``
  return composeSql`AND EXISTS (
    SELECT 1 FROM streams scope_s
    WHERE scope_s.id = conversations.stream_id
      AND scope_s.workspace_id = conversations.workspace_id
      AND COALESCE(scope_s.root_stream_id, scope_s.id) = ANY(${scopeStreamIds})
  )`
}

/**
 * The exclusion twin of {@link boardScopeCondSql}. A conversation is vetoed when
 * its ANCHOR or its effective ROOT is named — root matching drops a channel with
 * everything under it, anchor matching lets one thread be excluded without
 * dropping its channel. Exclusion always wins over an include scope (both are
 * AND'ed). Workspace-scoped inside the EXISTS (INV-8). Mirrored client-side in
 * `use-stable-board-view`'s `matchesExcludedStreams` — keep the anchor-or-root
 * rule identical.
 */
function boardScopeExcludeCondSql(excludeStreamIds: string[] | undefined) {
  if (!excludeStreamIds || excludeStreamIds.length === 0) return sql``
  return composeSql`AND NOT EXISTS (
    SELECT 1 FROM streams ex_s
    WHERE ex_s.id = conversations.stream_id
      AND ex_s.workspace_id = conversations.workspace_id
      AND (
        COALESCE(ex_s.root_stream_id, ex_s.id) = ANY(${excludeStreamIds})
        OR ex_s.id = ANY(${excludeStreamIds})
      )
  )`
}

/**
 * The board's stream-TYPE filter fragment. Matches on the effective root's
 * type (joined via the same `COALESCE(root_stream_id, id)` rule), so a
 * conversation anchored in a thread counts as its root channel/DM — a `types`
 * filter never sees `thread`. Workspace-scoped inside the EXISTS (INV-8).
 */
function boardTypeCondSql(scopeStreamTypes: string[] | undefined) {
  if (!scopeStreamTypes || scopeStreamTypes.length === 0) return sql``
  return composeSql`AND EXISTS (
    SELECT 1 FROM streams type_s
    JOIN streams type_root ON type_root.id = COALESCE(type_s.root_stream_id, type_s.id)
    WHERE type_s.id = conversations.stream_id
      AND type_s.workspace_id = conversations.workspace_id
      AND type_root.type = ANY(${scopeStreamTypes})
  )`
}

/** The exclusion twin of {@link boardTypeCondSql}: veto by effective-root type. */
function boardTypeExcludeCondSql(excludeStreamTypes: string[] | undefined) {
  if (!excludeStreamTypes || excludeStreamTypes.length === 0) return sql``
  return composeSql`AND NOT EXISTS (
    SELECT 1 FROM streams xt_s
    JOIN streams xt_root ON xt_root.id = COALESCE(xt_s.root_stream_id, xt_s.id)
    WHERE xt_s.id = conversations.stream_id
      AND xt_s.workspace_id = conversations.workspace_id
      AND xt_root.type = ANY(${excludeStreamTypes})
  )`
}

/**
 * EXISTS body shared by the board's label include/exclude filters: does the
 * VIEWER have one of `labelIds` on the conversation's anchor stream or its
 * effective root? Labels are owner-scoped, so the filter is per-viewer by
 * construction (like mute). Assignments of an archived label are deleted inside
 * the label-archive transaction, so no archived-label join is needed.
 * Workspace-scoped inside the EXISTS (INV-8). Mirrored client-side in
 * `use-stable-board-view`'s label matchers — keep the anchor-or-root rule
 * identical.
 */
function boardLabelMatchSql(userId: string, labelIds: string[]) {
  return composeSql`(
    SELECT 1 FROM label_assignments la
    JOIN streams lbl_s ON lbl_s.id = conversations.stream_id
      AND lbl_s.workspace_id = conversations.workspace_id
    WHERE la.workspace_id = conversations.workspace_id
      AND la.user_id = ${userId}
      AND la.resource_type = ${LabelableResourceTypes.STREAM}
      AND la.label_id = ANY(${labelIds})
      AND la.resource_id IN (lbl_s.id, COALESCE(lbl_s.root_stream_id, lbl_s.id))
  )`
}

/** Label scope: only conversations whose anchor/root carries one of the viewer's labels. */
function boardLabelCondSql(userId: string, labelIds: string[] | undefined) {
  if (!labelIds || labelIds.length === 0) return sql``
  return composeSql`AND EXISTS ${boardLabelMatchSql(userId, labelIds)}`
}

/** Label veto: drop conversations whose anchor/root carries one of the viewer's labels. */
function boardLabelExcludeCondSql(userId: string, labelIds: string[] | undefined) {
  if (!labelIds || labelIds.length === 0) return sql``
  return composeSql`AND NOT EXISTS ${boardLabelMatchSql(userId, labelIds)}`
}

/**
 * Per-viewer hide exclusion (board-view-design.md § "Hide & mute"). A hidden
 * conversation is suppressed UNLESS it revived — `last_activity_at` passing the
 * `hidden_at` watermark un-hides it (mirrored client-side in
 * `use-stable-board-view`; keep the `<=` boundary identical to avoid the SQL/JS
 * lockstep drift Map C flags).
 */
function boardHiddenExcludeSql(userId: string) {
  return composeSql`AND NOT EXISTS (
    SELECT 1 FROM board_hidden_conversations h
    WHERE h.conversation_id = conversations.id
      AND h.user_id = ${userId}
      AND h.workspace_id = conversations.workspace_id
      AND conversations.last_activity_at <= h.hidden_at
  )`
}

/**
 * Archived-stream exclusion, matched by effective ROOT
 * (`COALESCE(root_stream_id, id)`, mirroring `boardScopeCondSql`). Archiving
 * marks only the root row — a thread inherits its root's lifecycle (INV-62) — so
 * a conversation is archived exactly when its effective root is. Skipped when
 * `showArchived` is true (the viewer opted into seeing archived cards);
 * otherwise the board's default hides them. The projection stamps each surviving
 * card's effective-root archived state onto `BoardPost.rootArchived`, which the
 * client's `use-stable-board-view` reads to re-hide archived cards the instant
 * the viewer toggles archived back off — keep the effective-root rule identical.
 */
function boardArchivedExcludeSql(showArchived: boolean) {
  if (showArchived) return sql``
  return composeSql`AND NOT EXISTS (
    SELECT 1 FROM streams arch_s
    JOIN streams arch_root ON arch_root.id = COALESCE(arch_s.root_stream_id, arch_s.id)
    WHERE arch_s.id = conversations.stream_id
      AND arch_s.workspace_id = conversations.workspace_id
      AND arch_root.archived_at IS NOT NULL
  )`
}

/**
 * Per-viewer stream mute exclusion, matched by effective ROOT
 * (`COALESCE(root_stream_id, id)`, mirroring `boardScopeCondSql`). Skipped when
 * `applyMute` is false: an explicit `?in=` stream scope names streams the viewer
 * asked for, so mute doesn't fight it; mute still applies under no-scope and
 * under a type (`?is=`) scope.
 */
function boardMutedExcludeSql(userId: string, applyMute: boolean) {
  if (!applyMute) return sql``
  return composeSql`AND NOT EXISTS (
    SELECT 1 FROM board_muted_streams m
    JOIN streams ms ON ms.id = conversations.stream_id
      AND ms.workspace_id = conversations.workspace_id
      AND COALESCE(ms.root_stream_id, ms.id) = m.stream_id
    WHERE m.user_id = ${userId} AND m.workspace_id = conversations.workspace_id
  )`
}

interface ConversationRow {
  id: string
  stream_id: string
  workspace_id: string
  topic_summary: string | null
  summary: string | null
  completeness_score: number
  confidence: number
  status: string
  parent_conversation_id: string | null
  last_activity_at: Date
  created_at: Date
  updated_at: Date
  message_ids: string[]
  participant_ids: string[]
  secondary_message_ids: string[]
}

/**
 * Internal backend type with native Date objects. The wire type in @threa/types
 * uses ISO 8601 strings for JSON serialization.
 *
 * `messageIds` lists the messages whose PRIMARY conversation is this one,
 * preserved in insertion order. `secondaryMessageIds` lists messages that also
 * appear in this conversation but whose primary lives elsewhere (cross-topic
 * references). `participantIds` are the distinct authors of `messageIds`.
 *
 * All three are stored as Postgres TEXT[] arrays on the conversation row; the
 * service is the sole writer and uses row-level locking on the message row to
 * keep concurrent calls from duplicating membership.
 */
export interface Conversation {
  id: string
  streamId: string
  workspaceId: string
  messageIds: string[]
  participantIds: string[]
  secondaryMessageIds: string[]
  topicSummary: string | null
  summary: string | null
  completenessScore: number
  confidence: number
  status: ConversationStatus
  parentConversationId: string | null
  lastActivityAt: Date
  createdAt: Date
  updatedAt: Date
}

export interface InsertConversationParams {
  id: string
  streamId: string
  workspaceId: string
  topicSummary?: string
  summary?: string
  completenessScore?: number
  confidence?: number
  status?: ConversationStatus
  parentConversationId?: string
}

export interface UpdateConversationParams {
  topicSummary?: string
  summary?: string
  completenessScore?: number
  confidence?: number
  status?: ConversationStatus
  lastActivityAt?: Date
  /** Set true on a user's explicit resolve/reopen so the extractor stops
   *  overriding the status (user intent wins over the LLM's ruling). */
  statusLockedByUser?: boolean
}

function mapRowToConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    streamId: row.stream_id,
    workspaceId: row.workspace_id,
    messageIds: row.message_ids,
    participantIds: row.participant_ids,
    secondaryMessageIds: row.secondary_message_ids,
    topicSummary: row.topic_summary,
    summary: row.summary,
    completenessScore: row.completeness_score,
    confidence: row.confidence,
    status: row.status as ConversationStatus,
    parentConversationId: row.parent_conversation_id,
    lastActivityAt: row.last_activity_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

const SELECT_FIELDS = `
  id, stream_id, workspace_id,
  message_ids, participant_ids, secondary_message_ids,
  topic_summary, summary, completeness_score, confidence, status, parent_conversation_id,
  last_activity_at, created_at, updated_at
`

export const ConversationRepository = {
  async findById(db: Querier, id: string): Promise<Conversation | null> {
    const result = await db.query<ConversationRow>(sql`
      SELECT ${sql.raw(SELECT_FIELDS)} FROM conversations WHERE id = ${id}
    `)
    if (!result.rows[0]) return null
    return mapRowToConversation(result.rows[0])
  },

  /**
   * Workspace-scoped read that locks the row (INV-8 + INV-20). The declared
   * `existing` assignment path uses this so a concurrent resolve/delete of the
   * target conversation serializes behind the attach instead of racing it.
   * Returns null for a missing or cross-workspace id rather than leaking another
   * tenant's row.
   */
  async findByIdForUpdate(db: Querier, workspaceId: string, id: string): Promise<Conversation | null> {
    const result = await db.query<ConversationRow>(sql`
      SELECT ${sql.raw(SELECT_FIELDS)} FROM conversations
      WHERE id = ${id} AND workspace_id = ${workspaceId}
      FOR UPDATE
    `)
    if (!result.rows[0]) return null
    return mapRowToConversation(result.rows[0])
  },

  /**
   * Batch lookup; returns conversations in arbitrary order. Workspace-scoped
   * (INV-8) — rows from other workspaces are filtered out at the query level
   * even if the caller passes IDs from the wrong workspace.
   */
  async findByIds(db: Querier, workspaceId: string, ids: string[]): Promise<Conversation[]> {
    if (ids.length === 0) return []
    const result = await db.query<ConversationRow>(sql`
      SELECT ${sql.raw(SELECT_FIELDS)} FROM conversations
      WHERE workspace_id = ${workspaceId} AND id = ANY(${ids}::text[])
    `)
    return result.rows.map(mapRowToConversation)
  },

  async findByStream(
    db: Querier,
    streamId: string,
    options?: { status?: ConversationStatus; limit?: number }
  ): Promise<Conversation[]> {
    const limit = options?.limit ?? 50

    if (options?.status) {
      const result = await db.query<ConversationRow>(sql`
        SELECT ${sql.raw(SELECT_FIELDS)} FROM conversations
        WHERE stream_id = ${streamId} AND status = ${options.status}
        ORDER BY last_activity_at DESC
        LIMIT ${limit}
      `)
      return result.rows.map(mapRowToConversation)
    }

    const result = await db.query<ConversationRow>(sql`
      SELECT ${sql.raw(SELECT_FIELDS)} FROM conversations
      WHERE stream_id = ${streamId}
      ORDER BY last_activity_at DESC
      LIMIT ${limit}
    `)
    return result.rows.map(mapRowToConversation)
  },

  /**
   * Find conversations in a stream AND in any child threads of that stream.
   * Child threads are thread streams whose `parent_stream_id` is this stream —
   * anchor-agnostic, so threads on cards (event-anchored) are included too.
   */
  async findByStreamIncludingThreads(
    db: Querier,
    streamId: string,
    options?: { status?: ConversationStatus; limit?: number }
  ): Promise<Conversation[]> {
    const limit = options?.limit ?? 50

    if (options?.status) {
      const result = await db.query<ConversationRow>(sql`
        SELECT ${sql.raw(SELECT_FIELDS)} FROM conversations
        WHERE (
          stream_id = ${streamId}
          OR stream_id IN (
            SELECT s.id FROM streams s
            WHERE s.type = 'thread' AND s.parent_stream_id = ${streamId}
          )
        )
        AND status = ${options.status}
        ORDER BY last_activity_at DESC
        LIMIT ${limit}
      `)
      return result.rows.map(mapRowToConversation)
    }

    const result = await db.query<ConversationRow>(sql`
      SELECT ${sql.raw(SELECT_FIELDS)} FROM conversations
      WHERE stream_id = ${streamId}
         OR stream_id IN (
           SELECT s.id FROM streams s
           WHERE s.type = 'thread' AND s.parent_stream_id = ${streamId}
         )
      ORDER BY last_activity_at DESC
      LIMIT ${limit}
    `)
    return result.rows.map(mapRowToConversation)
  },

  /**
   * The stream's most recently active NON-EMPTY active conversation, bounded by
   * `activeSince`. Workspace-scoped (INV-8). Empty shells are excluded so a
   * provisional attach can't resurrect a conversation whose messages all moved
   * away, and the time bound keeps a long-dormant conversation from swallowing
   * an unrelated new message.
   */
  async findLatestActiveByStream(
    db: Querier,
    workspaceId: string,
    streamId: string,
    activeSince: Date
  ): Promise<Conversation | null> {
    const result = await db.query<ConversationRow>(sql`
      SELECT ${sql.raw(SELECT_FIELDS)} FROM conversations
      WHERE workspace_id = ${workspaceId}
        AND stream_id = ${streamId}
        AND status = ${ConversationStatuses.ACTIVE}
        AND cardinality(message_ids) > 0
        AND last_activity_at >= ${activeSince}
      ORDER BY last_activity_at DESC
      LIMIT 1
    `)
    if (!result.rows[0]) return null
    return mapRowToConversation(result.rows[0])
  },

  async findActiveByStream(db: Querier, streamId: string, limit = 50): Promise<Conversation[]> {
    return this.findByStream(db, streamId, { status: "active", limit })
  },

  /**
   * Conversations that contain a specific message (primary or secondary).
   * Workspace-scoped (INV-8). Uses the two GIN indexes on `message_ids` and
   * `secondary_message_ids`.
   */
  async findByMessageId(db: Querier, workspaceId: string, messageId: string): Promise<Conversation[]> {
    const result = await db.query<ConversationRow>(sql`
      SELECT ${sql.raw(SELECT_FIELDS)} FROM conversations
      WHERE workspace_id = ${workspaceId}
        AND (message_ids @> ARRAY[${messageId}]::text[] OR secondary_message_ids @> ARRAY[${messageId}]::text[])
      ORDER BY last_activity_at DESC
    `)
    return result.rows.map(mapRowToConversation)
  },

  /**
   * Find conversations that contain any of the given message IDs (primary or
   * secondary). Returns unique conversations. Workspace-scoped (INV-8).
   */
  async findByMessageIds(db: Querier, workspaceId: string, messageIds: string[]): Promise<Conversation[]> {
    if (messageIds.length === 0) return []
    const result = await db.query<ConversationRow>(sql`
      SELECT ${sql.raw(SELECT_FIELDS)} FROM conversations
      WHERE workspace_id = ${workspaceId}
        AND (message_ids && ${messageIds}::text[] OR secondary_message_ids && ${messageIds}::text[])
      ORDER BY last_activity_at DESC
    `)
    return result.rows.map(mapRowToConversation)
  },

  /**
   * Find the conversation that owns a message as PRIMARY (`message_ids`),
   * workspace-scoped. There can be at most one — enforced by the service, not
   * the database — so this returns a single row or null.
   */
  async findPrimaryByMessageId(db: Querier, workspaceId: string, messageId: string): Promise<Conversation | null> {
    const result = await db.query<ConversationRow>(sql`
      SELECT ${sql.raw(SELECT_FIELDS)} FROM conversations
      WHERE workspace_id = ${workspaceId}
        AND message_ids @> ARRAY[${messageId}]::text[]
      LIMIT 1
    `)
    if (!result.rows[0]) return null
    return mapRowToConversation(result.rows[0])
  },

  /**
   * Batch variant: returns a Map keyed by message_id of the conversation that
   * owns that message as primary. Missing keys → no primary. Workspace-scoped.
   *
   * The LATERAL unnest pairs each (message_id, conversation) row DB-side so
   * the Map is built in a single pass — no JS re-scan of message_ids arrays.
   */
  async findPrimariesByMessageIds(
    db: Querier,
    workspaceId: string,
    messageIds: string[]
  ): Promise<Map<string, Conversation>> {
    if (messageIds.length === 0) return new Map()
    const result = await db.query<ConversationRow & { matched_message_id: string }>(sql`
      SELECT ${sql.raw(SELECT_FIELDS)}, m.message_id AS matched_message_id
      FROM conversations c
      CROSS JOIN LATERAL unnest(c.message_ids) AS m(message_id)
      WHERE c.workspace_id = ${workspaceId}
        AND m.message_id = ANY(${messageIds}::text[])
    `)
    const byMessageId = new Map<string, Conversation>()
    for (const row of result.rows) {
      byMessageId.set(row.matched_message_id, mapRowToConversation(row))
    }
    return byMessageId
  },

  async findByWorkspace(
    db: Querier,
    workspaceId: string,
    options?: { status?: ConversationStatus; limit?: number }
  ): Promise<Conversation[]> {
    const limit = options?.limit ?? 50

    if (options?.status) {
      const result = await db.query<ConversationRow>(sql`
        SELECT ${sql.raw(SELECT_FIELDS)} FROM conversations
        WHERE workspace_id = ${workspaceId} AND status = ${options.status}
        ORDER BY last_activity_at DESC
        LIMIT ${limit}
      `)
      return result.rows.map(mapRowToConversation)
    }

    const result = await db.query<ConversationRow>(sql`
      SELECT ${sql.raw(SELECT_FIELDS)} FROM conversations
      WHERE workspace_id = ${workspaceId}
      ORDER BY last_activity_at DESC
      LIMIT ${limit}
    `)
    return result.rows.map(mapRowToConversation)
  },

  /**
   * Cross-stream conversation feed for the workspace board. Differs from
   * {@link findByWorkspace} in three board-critical ways:
   *  - access-filtered in SQL via the canonical thread→root predicate (INV-62),
   *    so the LIMIT counts only conversations the viewer can actually read;
   *  - empty resolved shells (`cardinality(message_ids) = 0`, left behind when a
   *    conversation's last message is reassigned away) are excluded so the board
   *    shows real topics, not tombstones; and
   *  - keyset-paginated on the total order `(last_activity_at, id) DESC` so the
   *    full board is reachable a page at a time instead of silently truncating
   *    at the first page. `id` is the tiebreaker that makes the order total (and
   *    the cursor unambiguous) when timestamps collide.
   *
   * `composeSql` (not `sql`) because the access predicate and the optional
   * status/cursor conditions are nested fragments; `SELECT_FIELDS` is pre-resolved
   * through `sql` so its raw text inlines rather than being parametrized. An
   * absent optional condition splices in as an empty fragment.
   */
  async findByWorkspaceForViewer(
    db: Querier,
    workspaceId: string,
    userId: string,
    options?: {
      status?: ConversationStatus
      lens?: BoardLens
      /** Root-stream scope: only conversations under these streams (see {@link boardScopeCondSql}). */
      scopeStreamIds?: string[]
      /** Root-stream TYPE scope: only conversations whose root is one of these types. */
      scopeStreamTypes?: string[]
      /** Stream veto: drop conversations whose anchor or root is named (see {@link boardScopeExcludeCondSql}). */
      excludeStreamIds?: string[]
      /** Root-stream TYPE veto: drop conversations whose root is one of these types. */
      excludeStreamTypes?: string[]
      /** Label scope: only conversations whose anchor/root carries one of the viewer's labels. */
      scopeLabelIds?: string[]
      /** Label veto: drop conversations whose anchor/root carries one of the viewer's labels. */
      excludeLabelIds?: string[]
      /** Include conversations under archived streams; defaults to hiding them. */
      showArchived?: boolean
      limit?: number
      cursor?: { lastActivityAt: string; id: string }
    }
  ): Promise<Conversation[]> {
    const limit = options?.limit ?? 50
    const fields = sql`${sql.raw(SELECT_FIELDS)}`
    const access = streamAccessPredicateSql(workspaceId, userId, "conversations.stream_id")
    const statusCond = options?.status ? composeSql`AND status = ${options.status}` : sql``
    const lensCond = boardLensCondSql(options?.lens, userId)
    const scopeCond = boardScopeCondSql(options?.scopeStreamIds)
    const typeCond = boardTypeCondSql(options?.scopeStreamTypes)
    const scopeExcludeCond = boardScopeExcludeCondSql(options?.excludeStreamIds)
    const typeExcludeCond = boardTypeExcludeCondSql(options?.excludeStreamTypes)
    const labelCond = boardLabelCondSql(userId, options?.scopeLabelIds)
    const labelExcludeCond = boardLabelExcludeCondSql(userId, options?.excludeLabelIds)
    const hiddenCond = boardHiddenExcludeSql(userId)
    const archivedCond = boardArchivedExcludeSql(options?.showArchived ?? false)
    // Mute is skipped when the viewer named explicit streams via `?in=`.
    const mutedCond = boardMutedExcludeSql(userId, !options?.scopeStreamIds?.length)
    // Keyset on `date_trunc('milliseconds', last_activity_at)` — NOT the raw
    // column — because the cursor is minted from a JS Date (ms precision) while
    // timestamptz stores microseconds. Comparing the raw µs value against an
    // ms-truncated cursor would skip any row whose activity falls in the same
    // millisecond as the boundary row but with smaller µs. Truncating both sides
    // to ms makes the order total at the cursor's own granularity (id breaks ms
    // ties), so no row is skipped or repeated across pages.
    const cursorCond = options?.cursor
      ? composeSql`AND (date_trunc('milliseconds', last_activity_at), id) < (${options.cursor.lastActivityAt}::timestamptz, ${options.cursor.id})`
      : sql``

    const result = await db.query<ConversationRow>(composeSql`
      SELECT ${fields} FROM conversations
      WHERE workspace_id = ${workspaceId}
        AND cardinality(message_ids) > 0
        ${statusCond}
        ${lensCond}
        ${scopeCond}
        ${typeCond}
        ${scopeExcludeCond}
        ${typeExcludeCond}
        ${labelCond}
        ${labelExcludeCond}
        ${hiddenCond}
        ${archivedCond}
        ${mutedCond}
        ${cursorCond}
        AND ${access}
      ORDER BY date_trunc('milliseconds', last_activity_at) DESC, id DESC
      LIMIT ${limit}
    `)
    return result.rows.map(mapRowToConversation)
  },

  /**
   * Feed variant for callers whose access is an explicit set of readable ROOT
   * streams rather than a user id (the public API's bot keys: public streams +
   * channel grants). A conversation qualifies when its anchor's effective root
   * (`COALESCE(root_stream_id, id)`, INV-62) is in the set and that root is not
   * archived — mirroring `isStreamAccessibleForBot`, which denies archived
   * streams per-id. Same tombstone exclusion and keyset order as
   * {@link findByWorkspaceForViewer} (see its cursor-truncation comment).
   */
  async findByWorkspaceForRoots(
    db: Querier,
    workspaceId: string,
    rootStreamIds: string[],
    options?: {
      status?: ConversationStatus
      limit?: number
      cursor?: { lastActivityAt: string; id: string }
    }
  ): Promise<Conversation[]> {
    if (rootStreamIds.length === 0) return []
    const limit = options?.limit ?? 50
    const fields = sql`${sql.raw(SELECT_FIELDS)}`
    const statusCond = options?.status ? composeSql`AND status = ${options.status}` : sql``
    const cursorCond = options?.cursor
      ? composeSql`AND (date_trunc('milliseconds', last_activity_at), id) < (${options.cursor.lastActivityAt}::timestamptz, ${options.cursor.id})`
      : sql``

    const result = await db.query<ConversationRow>(composeSql`
      SELECT ${fields} FROM conversations
      WHERE workspace_id = ${workspaceId}
        AND cardinality(message_ids) > 0
        ${statusCond}
        ${cursorCond}
        AND EXISTS (
          SELECT 1
          FROM streams eff_s
          JOIN streams eff_root ON eff_root.id = COALESCE(eff_s.root_stream_id, eff_s.id)
          WHERE eff_s.id = conversations.stream_id
            AND eff_s.workspace_id = ${workspaceId}
            AND eff_root.id = ANY(${rootStreamIds}::text[])
            AND eff_root.archived_at IS NULL
        )
      ORDER BY date_trunc('milliseconds', last_activity_at) DESC, id DESC
      LIMIT ${limit}
    `)
    return result.rows.map(mapRowToConversation)
  },

  async insert(db: Querier, params: InsertConversationParams): Promise<Conversation> {
    const result = await db.query<ConversationRow>(sql`
      INSERT INTO conversations (
        id, stream_id, workspace_id,
        topic_summary, summary, completeness_score, confidence, status, parent_conversation_id
      )
      VALUES (
        ${params.id},
        ${params.streamId},
        ${params.workspaceId},
        ${params.topicSummary ?? null},
        ${params.summary ?? null},
        ${params.completenessScore ?? 1},
        ${params.confidence ?? 0.5},
        ${params.status ?? "active"},
        ${params.parentConversationId ?? null}
      )
      RETURNING ${sql.raw(SELECT_FIELDS)}
    `)
    return mapRowToConversation(result.rows[0])
  },

  /**
   * Workspace-scoped update (INV-8). The UPDATE filters by workspace_id so a
   * misrouted conversation ID from a different workspace silently no-ops rather
   * than writing into another tenant's data.
   */
  async update(
    db: Querier,
    workspaceId: string,
    id: string,
    params: UpdateConversationParams
  ): Promise<Conversation | null> {
    const updates: string[] = []
    const values: unknown[] = []
    let paramIndex = 1

    if (params.topicSummary !== undefined) {
      updates.push(`topic_summary = $${paramIndex++}`)
      values.push(params.topicSummary)
    }
    if (params.summary !== undefined) {
      updates.push(`summary = $${paramIndex++}`)
      values.push(params.summary)
    }
    if (params.completenessScore !== undefined) {
      updates.push(`completeness_score = $${paramIndex++}`)
      values.push(params.completenessScore)
    }
    if (params.confidence !== undefined) {
      updates.push(`confidence = $${paramIndex++}`)
      values.push(params.confidence)
    }
    if (params.status !== undefined) {
      updates.push(`status = $${paramIndex++}`)
      values.push(params.status)
    }
    if (params.statusLockedByUser !== undefined) {
      updates.push(`status_locked_by_user = $${paramIndex++}`)
      values.push(params.statusLockedByUser)
    }
    if (params.lastActivityAt !== undefined) {
      updates.push(`last_activity_at = $${paramIndex++}`)
      values.push(params.lastActivityAt)
    }

    if (updates.length === 0) {
      // No-op update still goes through the workspace-scoped read so a
      // cross-workspace lookup returns null instead of leaking the row.
      const result = await db.query<ConversationRow>(sql`
        SELECT ${sql.raw(SELECT_FIELDS)} FROM conversations
        WHERE workspace_id = ${workspaceId} AND id = ${id}
      `)
      if (!result.rows[0]) return null
      return mapRowToConversation(result.rows[0])
    }

    updates.push(`updated_at = NOW()`)
    values.push(id, workspaceId)
    const idParamIndex = paramIndex++
    const workspaceParamIndex = paramIndex

    const query = `
      UPDATE conversations
      SET ${updates.join(", ")}
      WHERE id = $${idParamIndex} AND workspace_id = $${workspaceParamIndex}
      RETURNING ${SELECT_FIELDS}
    `

    const result = await db.query<ConversationRow>(query, values)
    if (!result.rows[0]) return null
    return mapRowToConversation(result.rows[0])
  },

  /**
   * The boundary-extraction LLM's status/completeness refinement. Unlike a user
   * edit ({@link update}), the extractor MUST NOT override a status the user set
   * — user resolution takes precedence over the AI's ruling (Kris, 2026-07-05).
   * `status` is applied only when the row isn't `status_locked_by_user`; the guard
   * is in the SET (a `CASE`), so it's atomic against a concurrent user resolve —
   * no read-then-write race (INV-20). `completeness_score` is always free to
   * refine. Workspace-scoped (INV-8).
   */
  async applyExtractionUpdate(
    db: Querier,
    workspaceId: string,
    id: string,
    params: { completenessScore?: number; status?: ConversationStatus; summary?: string }
  ): Promise<void> {
    await db.query(sql`
      UPDATE conversations SET
        completeness_score = COALESCE(${params.completenessScore ?? null}, completeness_score),
        status = CASE WHEN status_locked_by_user THEN status ELSE COALESCE(${params.status ?? null}, status) END,
        summary = COALESCE(${params.summary ?? null}, summary),
        updated_at = NOW()
      WHERE id = ${id} AND workspace_id = ${workspaceId}
    `)
  },

  /**
   * Append a message to `message_ids` (primary membership) and also add the
   * author to `participant_ids` if not already present. Idempotent: appending
   * a message_id that's already present is a no-op.
   *
   * Also clears the message from `secondary_message_ids` if it was there —
   * a message can be either primary or secondary in a given conversation, not
   * both.
   *
   * Workspace-scoped (INV-8). Caller is responsible for ensuring any prior
   * primary membership in another conversation has been removed first
   * (`removePrimaryMessage`), otherwise the message will appear in two
   * `message_ids` arrays and the "exactly one primary" invariant breaks.
   */
  async addPrimaryMessage(
    db: Querier,
    workspaceId: string,
    conversationId: string,
    messageId: string,
    authorId: string | null
  ): Promise<void> {
    await db.query(sql`
      UPDATE conversations
      SET message_ids =
            CASE WHEN message_ids @> ARRAY[${messageId}]::text[]
                 THEN message_ids
                 ELSE array_append(message_ids, ${messageId}) END,
          participant_ids =
            CASE WHEN ${authorId}::text IS NULL OR participant_ids @> ARRAY[${authorId}]::text[]
                 THEN participant_ids
                 ELSE array_append(participant_ids, ${authorId}) END,
          secondary_message_ids = array_remove(secondary_message_ids, ${messageId}),
          updated_at = NOW()
      WHERE id = ${conversationId} AND workspace_id = ${workspaceId}
    `)
  },

  /**
   * Append a message to `secondary_message_ids` (cross-topic reference). The
   * message's primary lives in another conversation. Idempotent and a no-op if
   * the message is already in this conversation's `message_ids` (would be a
   * downgrade — service must not request it).
   */
  async addSecondaryMessage(
    db: Querier,
    workspaceId: string,
    conversationId: string,
    messageId: string
  ): Promise<void> {
    await db.query(sql`
      UPDATE conversations
      SET secondary_message_ids =
            CASE WHEN message_ids @> ARRAY[${messageId}]::text[]
                  OR secondary_message_ids @> ARRAY[${messageId}]::text[]
                 THEN secondary_message_ids
                 ELSE array_append(secondary_message_ids, ${messageId}) END,
          updated_at = NOW()
      WHERE id = ${conversationId} AND workspace_id = ${workspaceId}
    `)
  },

  /**
   * Remove a message from a conversation's `message_ids` (primary membership).
   * Used by reassignment to clear the old home before adding to the new one.
   * Note: `participant_ids` is NOT recomputed — author may still have other
   * messages in this conversation. Recompute via `recomputeParticipants` if
   * the caller wants strict bookkeeping.
   */
  async removePrimaryMessage(
    db: Querier,
    workspaceId: string,
    conversationId: string,
    messageId: string
  ): Promise<void> {
    await db.query(sql`
      UPDATE conversations
      SET message_ids = array_remove(message_ids, ${messageId}),
          updated_at = NOW()
      WHERE id = ${conversationId} AND workspace_id = ${workspaceId}
    `)
  },

  /**
   * Batch primary-membership move-out (INV-56): drop every id in `messageIds`
   * from `message_ids` in one order-preserving statement, and SET
   * `participant_ids` to the caller-recomputed set. Unlike the single-message
   * {@link removePrimaryMessage} the caller here knows exactly who remains (it
   * holds the full member→author map), so participants are recomputed rather
   * than left stale. Workspace-scoped (INV-8).
   */
  async removePrimaryMessages(
    db: Querier,
    workspaceId: string,
    conversationId: string,
    messageIds: string[],
    participantIds: string[]
  ): Promise<void> {
    await db.query(sql`
      UPDATE conversations
      SET message_ids = ARRAY(
            SELECT e FROM unnest(message_ids) WITH ORDINALITY AS t(e, ord)
            WHERE e <> ALL(${messageIds}::text[])
            ORDER BY ord
          ),
          participant_ids = ${participantIds}::text[],
          updated_at = NOW()
      WHERE id = ${conversationId} AND workspace_id = ${workspaceId}
    `)
  },

  /**
   * Batch primary-membership move-in (INV-56): append every id in `messageIds`
   * to `message_ids` (idempotent — a dedup keeps first-occurrence order),
   * clear them from `secondary_message_ids` (primary wins over secondary, as in
   * {@link addPrimaryMessage}), and SET `participant_ids` to the caller-recomputed
   * set. The caller must pass the FULL intended participant list. Workspace-scoped
   * (INV-8); the target's prior primary in another conversation must already be
   * removed (`removePrimaryMessages`).
   */
  async addPrimaryMessages(
    db: Querier,
    workspaceId: string,
    conversationId: string,
    messageIds: string[],
    participantIds: string[]
  ): Promise<void> {
    await db.query(sql`
      UPDATE conversations
      SET message_ids = ARRAY(
            SELECT e FROM (
              SELECT e, MIN(ord) AS ord
              FROM unnest(message_ids || ${messageIds}::text[]) WITH ORDINALITY AS t(e, ord)
              GROUP BY e
            ) deduped
            ORDER BY ord
          ),
          participant_ids = ${participantIds}::text[],
          secondary_message_ids = ARRAY(
            SELECT e FROM unnest(secondary_message_ids) WITH ORDINALITY AS t(e, ord)
            WHERE e <> ALL(${messageIds}::text[])
            ORDER BY ord
          ),
          updated_at = NOW()
      WHERE id = ${conversationId} AND workspace_id = ${workspaceId}
    `)
  },

  /**
   * Resolve a conversation that no longer owns any primary messages. The
   * emptiness check runs inside the UPDATE (INV-20): a concurrent extraction
   * appending to `message_ids` between the caller's read and this write makes
   * the condition fail under the row lock instead of resolving a conversation
   * that just gained a message. Workspace-scoped (INV-8).
   */
  async resolveIfEmpty(db: Querier, workspaceId: string, conversationId: string): Promise<void> {
    await db.query(sql`
      UPDATE conversations
      SET status = ${ConversationStatuses.RESOLVED}, updated_at = NOW()
      WHERE id = ${conversationId} AND workspace_id = ${workspaceId}
        AND cardinality(message_ids) = 0
    `)
  },

  /**
   * Flip a stalled or resolved conversation back to active. Applied whenever a
   * message moves into one — gaining a message means it has activity again,
   * whether it was resolved by a normal workflow, auto-resolved on becoming
   * empty (which keeps the emptied conversation usable as an undo target), or
   * faded by the staleness sweep. Conditional in SQL (INV-20), so it no-ops
   * for active conversations.
   */
  /**
   * Returns true when the conversation was actually reopened (was
   * resolved/stalled). A user-locked status is never undone here — the user's
   * "Mark resolved" wins over the fact that a message arrived (same rule as
   * applyExtractionUpdate's guard); messages still land in the conversation.
   */
  async reactivateIfInactive(db: Querier, workspaceId: string, conversationId: string): Promise<boolean> {
    const result = await db.query(sql`
      UPDATE conversations
      SET status = ${ConversationStatuses.ACTIVE}, updated_at = NOW()
      WHERE id = ${conversationId} AND workspace_id = ${workspaceId}
        AND status IN (${ConversationStatuses.RESOLVED}, ${ConversationStatuses.STALLED})
        AND NOT status_locked_by_user
      RETURNING id
    `)
    return (result.rowCount ?? 0) > 0
  },

  /**
   * Fade idle conversations: active → stalled after `stalledAfterSeconds` of
   * silence, active/stalled → resolved after `resolvedAfterSeconds`. The LLM
   * extractor only sees (and can only close) conversations still inside its
   * message window, so anything that scrolls out would otherwise stay "active"
   * forever — this sweep is the out-of-window counterpart.
   *
   * Set-based (INV-56) and cross-workspace by design: it is a system
   * maintenance job like queue internals, and every returned row still carries
   * its workspace for scoped event emission. `SKIP LOCKED` keeps the sweep
   * from blocking on rows a live extraction holds; `limit` bounds the
   * transaction so the first run over a large backlog drains in slices.
   * Returns the transitioned conversations for outbox emission.
   */
  async sweepStale(
    db: Querier,
    params: { stalledAfterSeconds: number; resolvedAfterSeconds: number; limit: number }
  ): Promise<Conversation[]> {
    const result = await db.query<ConversationRow>(sql`
      WITH candidates AS (
        SELECT id,
          CASE
            WHEN last_activity_at < NOW() - make_interval(secs => ${params.resolvedAfterSeconds})
              THEN ${ConversationStatuses.RESOLVED}
            ELSE ${ConversationStatuses.STALLED}
          END AS next_status
        FROM conversations
        WHERE (
          status = ${ConversationStatuses.ACTIVE}
            AND last_activity_at < NOW() - make_interval(secs => ${params.stalledAfterSeconds})
        ) OR (
          status = ${ConversationStatuses.STALLED}
            AND last_activity_at < NOW() - make_interval(secs => ${params.resolvedAfterSeconds})
        )
        ORDER BY last_activity_at
        LIMIT ${params.limit}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE conversations c
      SET status = candidates.next_status, updated_at = NOW()
      FROM candidates
      WHERE c.id = candidates.id
      RETURNING ${sql.raw(
        SELECT_FIELDS.split(",")
          .map((f) => `c.${f.trim()}`)
          .join(", ")
      )}
    `)
    return result.rows.map(mapRowToConversation)
  },

  /** Bump last_activity_at on many conversations in one round-trip. Workspace-scoped (INV-8). */
  async bumpActivityForIds(db: Querier, workspaceId: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return
    await db.query(sql`
      UPDATE conversations
      SET last_activity_at = NOW(), updated_at = NOW()
      WHERE workspace_id = ${workspaceId} AND id = ANY(${ids}::text[])
    `)
  },

  async delete(db: Querier, id: string): Promise<boolean> {
    const result = await db.query(sql`DELETE FROM conversations WHERE id = ${id}`)
    return result.rowCount !== null && result.rowCount > 0
  },
}

/** Distinct non-null author ids of `ids`, in first-appearance order — the
 *  recomputed `participant_ids` for a membership move. */
export function distinctAuthors(ids: string[], messages: Map<string, { authorId: string | null }>): string[] {
  const seen = new Set<string>()
  const authors: string[] = []
  for (const id of ids) {
    const authorId = messages.get(id)?.authorId
    if (authorId && !seen.has(authorId)) {
      seen.add(authorId)
      authors.push(authorId)
    }
  }
  return authors
}
