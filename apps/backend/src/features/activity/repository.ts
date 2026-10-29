import type { QueryConfig } from "pg"
import type { Querier } from "../../db"
import { sql, composeSql } from "../../db"
import { activityId } from "../../lib/id"
import { effectivelyArchivedSql } from "../../lib/sql-filters"
import { listAccessibleStreamIds, streamAccessPredicateSql } from "../streams"
import { ActivityTypes, MENTION_ACTIVITY_TYPES } from "@threahq/types"

interface ActivityRow {
  id: string
  workspace_id: string
  user_id: string
  activity_type: string
  stream_id: string | null
  message_id: string | null
  actor_id: string
  actor_type: string
  context: Record<string, unknown>
  read_at: Date | null
  created_at: Date
  is_self: boolean
  emoji: string | null
}

export interface Activity {
  id: string
  workspaceId: string
  userId: string
  activityType: string
  /** Null only for saved_reminder rows fired by standalone (message-less) saved items. */
  streamId: string | null
  messageId: string | null
  actorId: string
  actorType: string
  context: Record<string, unknown>
  readAt: Date | null
  createdAt: Date
  isSelf: boolean
  emoji: string | null
}

/** A row flipped from unread to read by a mark-read UPDATE (its RETURNING content). */
export interface ClearedActivity {
  activityId: string
  streamId: string | null
}

interface ClearedActivityRow {
  activity_id: string
  stream_id: string | null
}

export interface InsertActivityParams {
  workspaceId: string
  userId: string
  activityType: string
  /** Null only for saved_reminder rows fired by standalone (message-less) saved items. */
  streamId: string | null
  messageId: string | null
  /** User/persona/bot/system id of the actor whose action produced this row. */
  actorId: string
  actorType: string
  context?: Record<string, unknown>
  isSelf?: boolean
  /** Required when activityType === "reaction"; NULL for all other types. */
  emoji?: string | null
}

export interface InsertActivityBatchParams {
  workspaceId: string
  userIds: string[]
  activityType: string
  streamId: string
  messageId: string
  actorId: string
  actorType: string
  context?: Record<string, unknown>
  /**
   * Mark these rows as the user's own activity. Self rows are inserted already
   * read so they show in the feed without inflating unread counts.
   */
  isSelf?: boolean
  /**
   * Recipients whose read watermark already covers this message. Their rows are
   * inserted already read (read_at = NOW()) so an activity for a message the user
   * has already read never resurfaces as unread — the same born-read treatment as
   * self rows, applied per user rather than to the whole batch.
   */
  readUserIds?: ReadonlySet<string>
  /** Required when activityType === "reaction"; NULL for all other types. */
  emoji?: string | null
}

const MENTION_TYPES = [...MENTION_ACTIVITY_TYPES]

/** Column list for user_activity; single source of truth for SELECT lists */
const USER_ACTIVITY_COLUMNS =
  "id, workspace_id, user_id, activity_type, stream_id, message_id, actor_id, actor_type, context, read_at, created_at, is_self, emoji"

function mapRowToActivity(row: ActivityRow): Activity {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    userId: row.user_id,
    activityType: row.activity_type,
    streamId: row.stream_id,
    messageId: row.message_id,
    actorId: row.actor_id,
    actorType: row.actor_type,
    context: row.context,
    readAt: row.read_at,
    createdAt: row.created_at,
    isSelf: row.is_self,
    emoji: row.emoji,
  }
}

/**
 * Rows whose stream is sealed (archived itself or under an archived ancestor)
 * leave the feed and the badge counts while the seal holds, and come back
 * when it lifts: archival writes nothing to `user_activity`. Rows with no
 * stream (standalone saved reminders) always pass.
 */
const STREAM_NOT_SEALED = sql.raw(`(user_activity.stream_id IS NULL OR NOT EXISTS (
  SELECT 1 FROM streams s
  WHERE s.id = user_activity.stream_id
    AND s.workspace_id = user_activity.workspace_id
    AND ${effectivelyArchivedSql("s")}
))`)

/**
 * Rows on a stream the reader can no longer read (removed from its private root, a doc's share
 * revoked) leave the feed and the counts, and come back with access: losing access writes nothing
 * to `user_activity`. Rows with no stream pass.
 */
function streamReadableSql(workspaceId: string, userId: string): QueryConfig {
  return composeSql`(user_activity.stream_id IS NULL OR ${streamAccessPredicateSql(workspaceId, userId, "user_activity.stream_id")})`
}

/**
 * Pick the ON CONFLICT target for the given activity type. Reactions dedup by
 * (workspace, user, message, actor, emoji); most other types dedup by
 * (workspace, user, message, type, actor). Both are partial unique indexes —
 * the WHERE clause is required so Postgres can match the conflict target to
 * the correct index.
 *
 * `saved_reminder` is intentionally excluded from the non-reaction dedup index
 * (see migration 20260417200220) because the firing service is already
 * idempotent via `reminder_sent_at IS NULL`, and each save-then-remind
 * lifecycle should produce a distinct feed row. For that type we emit a plain
 * INSERT with no ON CONFLICT clause.
 */
function conflictClauseFor(activityType: string) {
  if (activityType === ActivityTypes.REACTION) {
    return sql.raw(
      "ON CONFLICT (workspace_id, user_id, message_id, actor_id, emoji) WHERE activity_type = 'reaction' DO UPDATE SET read_at = COALESCE(user_activity.read_at, EXCLUDED.read_at)"
    )
  }
  if (activityType === ActivityTypes.SAVED_REMINDER || activityType === ActivityTypes.MISSED_CALL) {
    // Both carry a null message_id, so the (…, message_id, …) dedup arbiter can
    // never match — emit a plain INSERT and let every occurrence mint a row.
    return sql.raw("")
  }
  return sql.raw(
    "ON CONFLICT (workspace_id, user_id, message_id, activity_type, actor_id) WHERE activity_type NOT IN ('reaction', 'saved_reminder') DO UPDATE SET read_at = COALESCE(user_activity.read_at, EXCLUDED.read_at)"
  )
}

export const ActivityRepository = {
  async insert(db: Querier, params: InsertActivityParams): Promise<Activity | null> {
    const id = activityId()
    const isSelf = params.isSelf ?? false
    // Self rows are inserted already read so they show in the feed without
    // inflating unread counts.
    const readAt = isSelf ? new Date() : null
    const emoji = params.emoji ?? null
    const result = await db.query<ActivityRow>(sql`
      INSERT INTO user_activity (
        id, workspace_id, user_id, activity_type, stream_id, message_id,
        actor_id, actor_type, context, is_self, read_at, emoji
      )
      SELECT
        ${id},
        ${params.workspaceId},
        ${params.userId},
        ${params.activityType},
        ${params.streamId},
        ${params.messageId},
        ${params.actorId},
        ${params.actorType},
        ${JSON.stringify(params.context ?? {})}::jsonb,
        ${isSelf},
        ${readAt}::timestamptz,
        ${emoji}
      WHERE NOT EXISTS (
        SELECT 1 FROM users u
        WHERE u.workspace_id = ${params.workspaceId} AND u.id = ${params.userId} AND u.origin_workspace_id IS NOT NULL
      )
      ${conflictClauseFor(params.activityType)}
      RETURNING ${sql.raw(USER_ACTIVITY_COLUMNS)}
    `)
    return result.rows[0] ? mapRowToActivity(result.rows[0]) : null
  },

  /**
   * Batch insert activities for multiple users sharing the same message context.
   * Single UNNEST query replaces N sequential inserts. ON CONFLICT deduplicates.
   *
   * When `isSelf` is true, rows are inserted already read (read_at = NOW()) so
   * the user's own activity shows in the feed without inflating unread counts.
   */
  async insertBatch(db: Querier, params: InsertActivityBatchParams): Promise<Activity[]> {
    if (params.userIds.length === 0) return []

    const ids = params.userIds.map(() => activityId())
    const contextJson = JSON.stringify(params.context ?? {})
    const isSelf = params.isSelf ?? false
    const emoji = params.emoji ?? null
    // read_at is per-row: self rows are always born read; non-self rows are born
    // read only for recipients whose watermark already covers this message.
    const nowIso = new Date().toISOString()
    const readAt = params.userIds.map((userId) => (isSelf || params.readUserIds?.has(userId) ? nowIso : null))

    const result = await db.query<ActivityRow>(sql`
      INSERT INTO user_activity (
        id, workspace_id, user_id, activity_type, stream_id, message_id,
        actor_id, actor_type, context, is_self, read_at, emoji
      )
      SELECT
        id, workspace_id, user_id, activity_type, stream_id, message_id,
        actor_id, actor_type, context, ${isSelf}, read_at, ${emoji}
      FROM UNNEST(
        ${ids}::text[],
        ${params.userIds.map(() => params.workspaceId)}::text[],
        ${params.userIds}::text[],
        ${params.userIds.map(() => params.activityType)}::text[],
        ${params.userIds.map(() => params.streamId)}::text[],
        ${params.userIds.map(() => params.messageId)}::text[],
        ${params.userIds.map(() => params.actorId)}::text[],
        ${params.userIds.map(() => params.actorType)}::text[],
        ${params.userIds.map(() => contextJson)}::jsonb[],
        ${readAt}::timestamptz[]
      ) AS t(id, workspace_id, user_id, activity_type, stream_id, message_id, actor_id, actor_type, context, read_at)
      WHERE NOT EXISTS (
        SELECT 1 FROM users u
        WHERE u.workspace_id = t.workspace_id AND u.id = t.user_id AND u.origin_workspace_id IS NOT NULL
      )
      ${conflictClauseFor(params.activityType)}
      RETURNING ${sql.raw(USER_ACTIVITY_COLUMNS)}
    `)
    return result.rows.map(mapRowToActivity)
  },

  async listByUser(
    db: Querier,
    userId: string,
    workspaceId: string,
    opts?: { limit?: number; cursor?: string; unreadOnly?: boolean; mineOnly?: boolean; othersOnly?: boolean }
  ): Promise<Activity[]> {
    const limit = opts?.limit ?? 50
    const hasCursor = opts?.cursor !== undefined
    const cursor = opts?.cursor ?? ""
    const unreadOnly = opts?.unreadOnly ?? false
    const mineOnly = opts?.mineOnly ?? false
    const othersOnly = opts?.othersOnly ?? false

    const result = await db.query<ActivityRow>(composeSql`
      SELECT ${sql`${sql.raw(USER_ACTIVITY_COLUMNS)}`}
      FROM user_activity
      WHERE user_id = ${userId}
        AND workspace_id = ${workspaceId}
        AND (${!unreadOnly} OR read_at IS NULL)
        AND (${!mineOnly} OR is_self = TRUE)
        AND (${!othersOnly} OR is_self = FALSE)
        AND ${sql`${STREAM_NOT_SEALED}`}
        AND ${streamReadableSql(workspaceId, userId)}
        AND (${!hasCursor} OR created_at < (
          SELECT created_at FROM user_activity
          WHERE id = ${cursor} AND user_id = ${userId} AND workspace_id = ${workspaceId}
        ))
      ORDER BY created_at DESC
      LIMIT ${limit}
    `)
    return result.rows.map(mapRowToActivity)
  },

  /**
   * Per-stream mention counts, per-stream total counts, and workspace-wide total
   * — one GROUP BY with FILTER, limited to streams the reader can still read.
   *
   * Self rows are excluded because they're inserted already read; this keeps
   * the filter explicit and defensive against any future change to that invariant.
   */
  async countUnreadGrouped(
    db: Querier,
    userId: string,
    workspaceId: string
  ): Promise<{ mentionsByStream: Map<string, number>; totalByStream: Map<string, number>; total: number }> {
    const result = await db.query<{ stream_id: string; mention_count: string; total_count: string }>(sql`
      SELECT
        stream_id,
        COUNT(*) FILTER (WHERE activity_type = ANY(${MENTION_TYPES}::text[]))::text AS mention_count,
        COUNT(*)::text AS total_count
      FROM user_activity
      WHERE user_id = ${userId}
        AND workspace_id = ${workspaceId}
        AND read_at IS NULL
        AND is_self = FALSE
        AND ${STREAM_NOT_SEALED}
      GROUP BY stream_id
    `)
    // Access is checked in a second query over just the streams holding unread rows: folded into
    // the count, the predicate inflates the plan enough to trip JIT compilation at a few thousand rows.
    const readable = await listAccessibleStreamIds(
      db,
      workspaceId,
      userId,
      result.rows.flatMap((row) => (row.stream_id ? [row.stream_id] : []))
    )
    const mentionsByStream = new Map<string, number>()
    const totalByStream = new Map<string, number>()
    let total = 0
    for (const row of result.rows.filter((r) => r.stream_id === null || readable.has(r.stream_id))) {
      const mentions = Number(row.mention_count)
      const count = Number(row.total_count)
      if (mentions > 0) mentionsByStream.set(row.stream_id, mentions)
      totalByStream.set(row.stream_id, count)
      total += count
    }
    return { mentionsByStream, totalByStream, total }
  },

  async countUnreadForStream(
    db: Querier,
    userId: string,
    workspaceId: string,
    streamId: string
  ): Promise<{ mentionCount: number; totalCount: number }> {
    const result = await db.query<{ mention_count: string; total_count: string }>(composeSql`
      SELECT
        COUNT(*) FILTER (WHERE activity_type = ANY(${MENTION_TYPES}::text[]))::text AS mention_count,
        COUNT(*)::text AS total_count
      FROM user_activity
      WHERE user_id = ${userId}
        AND workspace_id = ${workspaceId}
        AND stream_id = ${streamId}
        AND read_at IS NULL
        AND is_self = FALSE
        AND ${streamReadableSql(workspaceId, userId)}
    `)

    const row = result.rows[0]
    return {
      mentionCount: Number(row?.mention_count ?? 0),
      totalCount: Number(row?.total_count ?? 0),
    }
  },

  async markAsRead(
    db: Querier,
    workspaceId: string,
    userId: string,
    activityId: string
  ): Promise<ClearedActivity | null> {
    const result = await db.query<ClearedActivityRow>(sql`
      UPDATE user_activity
      SET read_at = NOW()
      WHERE workspace_id = ${workspaceId}
        AND id = ${activityId}
        AND user_id = ${userId}
        AND read_at IS NULL
      RETURNING id AS activity_id, stream_id
    `)
    const row = result.rows[0]
    return row ? { activityId: row.activity_id, streamId: row.stream_id } : null
  },

  /**
   * Mark a user's unread activity rows read for specific messages — the
   * message-granular coupling for conversation reads: marking a conversation
   * read clears exactly its messages' activity, never the stream's other
   * topics (contrast `markStreamAsRead`, the whole-stream open coupling).
   */
  /**
   * Of `messageIds`, which ones `@`-mentioned `userId` — the Mine-lens signal
   * (board `buildBoardPosts`). One batched presence read (INV-56), index-backed by
   * the non-reaction dedup key on (workspace, user, message, type, actor)
   * (mention is non-reaction).
   * Workspace-scoped (INV-8); `ActivityTypes.MENTION`, not a literal (INV-33).
   */
  async findMentionedMessageIds(
    db: Querier,
    workspaceId: string,
    userId: string,
    messageIds: string[]
  ): Promise<Set<string>> {
    if (messageIds.length === 0) return new Set()
    const result = await db.query<{ message_id: string }>(sql`
      SELECT DISTINCT message_id FROM user_activity
      WHERE workspace_id = ${workspaceId}
        AND user_id = ${userId}
        AND activity_type = ${ActivityTypes.MENTION}
        AND message_id = ANY(${messageIds}::text[])
    `)
    return new Set(result.rows.map((row) => row.message_id))
  },

  async markMessagesAsRead(db: Querier, workspaceId: string, userId: string, messageIds: string[]): Promise<number> {
    if (messageIds.length === 0) return 0
    const result = await db.query(sql`
      UPDATE user_activity
      SET read_at = NOW()
      WHERE workspace_id = ${workspaceId}
        AND user_id = ${userId}
        AND message_id = ANY(${messageIds}::text[])
        AND read_at IS NULL
    `)
    return result.rowCount ?? 0
  },

  async markStreamAsRead(
    db: Querier,
    workspaceId: string,
    userId: string,
    streamId: string
  ): Promise<ClearedActivity[]> {
    const result = await db.query<ClearedActivityRow>(sql`
      UPDATE user_activity
      SET read_at = NOW()
      WHERE workspace_id = ${workspaceId}
        AND user_id = ${userId}
        AND stream_id = ${streamId}
        AND read_at IS NULL
      RETURNING id AS activity_id, stream_id
    `)
    return result.rows.map((row) => ({ activityId: row.activity_id, streamId: row.stream_id }))
  },

  async markStreamsAsRead(
    db: Querier,
    workspaceId: string,
    userId: string,
    streamIds: string[]
  ): Promise<ClearedActivity[]> {
    if (streamIds.length === 0) return []
    const result = await db.query<ClearedActivityRow>(sql`
      UPDATE user_activity
      SET read_at = NOW()
      WHERE workspace_id = ${workspaceId}
        AND user_id = ${userId}
        AND stream_id = ANY(${streamIds}::text[])
        AND read_at IS NULL
      RETURNING id AS activity_id, stream_id
    `)
    return result.rows.map((row) => ({ activityId: row.activity_id, streamId: row.stream_id }))
  },

  async markAllAsRead(db: Querier, workspaceId: string, userId: string): Promise<ClearedActivity[]> {
    const result = await db.query<ClearedActivityRow>(composeSql`
      UPDATE user_activity
      SET read_at = NOW()
      WHERE workspace_id = ${workspaceId}
        AND user_id = ${userId}
        AND read_at IS NULL
        AND ${streamReadableSql(workspaceId, userId)}
      RETURNING id AS activity_id, stream_id
    `)
    return result.rows.map((row) => ({ activityId: row.activity_id, streamId: row.stream_id }))
  },

  /**
   * Of `activityIds`, which are still unread — under FOR SHARE, as the
   * activity:created publisher's ordering barrier against activity:read: a row
   * can be read (and its activity:read logged) between the source transaction's
   * commit and the publish. The share lock serializes the two — a concurrent
   * read UPDATE blocks until this transaction commits, so the sync log orders
   * created before read; a read committed first shows up here as already read
   * and the stale creation is never published.
   */
  async findStillUnreadIds(db: Querier, workspaceId: string, activityIds: string[]): Promise<Set<string>> {
    if (activityIds.length === 0) return new Set()
    const result = await db.query<{ id: string }>(sql`
      SELECT id FROM user_activity
      WHERE workspace_id = ${workspaceId}
        AND id = ANY(${activityIds}::text[])
        AND read_at IS NULL
      FOR SHARE
    `)
    return new Set(result.rows.map((row) => row.id))
  },

  /**
   * One activity row owned by `userId`, plus whether its stream is currently
   * sealed. Plain read (no lock): delayed push delivery re-reads it on every
   * attempt and must never block the mark-read UPDATE.
   */
  async findForUser(
    db: Querier,
    workspaceId: string,
    userId: string,
    activityId: string
  ): Promise<{ activity: Activity; streamSealed: boolean } | null> {
    const result = await db.query<ActivityRow & { stream_not_sealed: boolean }>(sql`
      SELECT ${sql.raw(USER_ACTIVITY_COLUMNS)}, ${STREAM_NOT_SEALED} AS stream_not_sealed
      FROM user_activity
      WHERE workspace_id = ${workspaceId}
        AND user_id = ${userId}
        AND id = ${activityId}
    `)
    const row = result.rows[0]
    return row ? { activity: mapRowToActivity(row), streamSealed: !row.stream_not_sealed } : null
  },

  /**
   * Delete the reaction activity row for a specific (message, actor, emoji).
   * Removes exactly what `processReactionAdded` would have created for that
   * emoji — the author's notification row and the reactor's self row are
   * scoped by user_id so both are deleted together here.
   * Returns deleted rows so the caller can emit compensating socket events.
   */
  async deleteReactionForEmoji(
    db: Querier,
    params: { workspaceId: string; messageId: string; actorId: string; emoji: string }
  ): Promise<Activity[]> {
    const result = await db.query<ActivityRow>(sql`
      DELETE FROM user_activity
      WHERE workspace_id = ${params.workspaceId}
        AND message_id = ${params.messageId}
        AND activity_type = 'reaction'
        AND actor_id = ${params.actorId}
        AND emoji = ${params.emoji}
      RETURNING ${sql.raw(USER_ACTIVITY_COLUMNS)}
    `)
    return result.rows.map(mapRowToActivity)
  },
}
