import type { Querier } from "../../db"
import { sql } from "../../db"
import { activityId } from "../../lib/id"
import { ActivityTypes } from "@threa/types"

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
  /** Required when activityType === "reaction"; NULL for all other types. */
  emoji?: string | null
}

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
 * Pick the ON CONFLICT target for the given activity type. Reactions dedup by
 * (user, message, actor, emoji); most other types dedup by (user, message,
 * type, actor). Both are partial unique indexes — the WHERE clause is required
 * so Postgres can match the conflict target to the correct index.
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
      "ON CONFLICT (user_id, message_id, actor_id, emoji) WHERE activity_type = 'reaction' DO UPDATE SET id = user_activity.id"
    )
  }
  if (activityType === ActivityTypes.SAVED_REMINDER) {
    return sql.raw("")
  }
  return sql.raw(
    "ON CONFLICT (user_id, message_id, activity_type, actor_id) WHERE activity_type NOT IN ('reaction', 'saved_reminder') DO UPDATE SET id = user_activity.id"
  )
}

export const ActivityRepository = {
  async insert(db: Querier, params: InsertActivityParams): Promise<Activity | null> {
    const id = activityId()
    const isSelf = params.isSelf ?? false
    // Self rows are inserted already read so they show in the feed without
    // inflating unread counts. Using a JS Date keeps the call tree consistent
    // with other repo methods that round-trip timestamps through parameters.
    const readAt = isSelf ? new Date() : null
    const emoji = params.emoji ?? null
    const result = await db.query<ActivityRow>(sql`
      INSERT INTO user_activity (
        id, workspace_id, user_id, activity_type, stream_id, message_id,
        actor_id, actor_type, context, is_self, read_at, emoji
      )
      VALUES (
        ${id},
        ${params.workspaceId},
        ${params.userId},
        ${params.activityType},
        ${params.streamId},
        ${params.messageId},
        ${params.actorId},
        ${params.actorType},
        ${JSON.stringify(params.context ?? {})},
        ${isSelf},
        ${readAt},
        ${emoji}
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
    const readAt = isSelf ? new Date() : null
    const emoji = params.emoji ?? null

    const result = await db.query<ActivityRow>(sql`
      INSERT INTO user_activity (
        id, workspace_id, user_id, activity_type, stream_id, message_id,
        actor_id, actor_type, context, is_self, read_at, emoji
      )
      SELECT
        id, workspace_id, user_id, activity_type, stream_id, message_id,
        actor_id, actor_type, context, ${isSelf}, ${readAt}, ${emoji}
      FROM UNNEST(
        ${ids}::text[],
        ${params.userIds.map(() => params.workspaceId)}::text[],
        ${params.userIds}::text[],
        ${params.userIds.map(() => params.activityType)}::text[],
        ${params.userIds.map(() => params.streamId)}::text[],
        ${params.userIds.map(() => params.messageId)}::text[],
        ${params.userIds.map(() => params.actorId)}::text[],
        ${params.userIds.map(() => params.actorType)}::text[],
        ${params.userIds.map(() => contextJson)}::jsonb[]
      ) AS t(id, workspace_id, user_id, activity_type, stream_id, message_id, actor_id, actor_type, context)
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

    const result = await db.query<ActivityRow>(sql`
      SELECT ${sql.raw(USER_ACTIVITY_COLUMNS)}
      FROM user_activity
      WHERE user_id = ${userId}
        AND workspace_id = ${workspaceId}
        AND (${!unreadOnly} OR read_at IS NULL)
        AND (${!mineOnly} OR is_self = TRUE)
        AND (${!othersOnly} OR is_self = FALSE)
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
   * Single-scan aggregation: per-stream mention counts, per-stream total counts,
   * and workspace-wide total — all from one GROUP BY with FILTER.
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
        COUNT(*) FILTER (WHERE activity_type = 'mention')::text AS mention_count,
        COUNT(*)::text AS total_count
      FROM user_activity
      WHERE user_id = ${userId}
        AND workspace_id = ${workspaceId}
        AND read_at IS NULL
        AND is_self = FALSE
      GROUP BY stream_id
    `)
    const mentionsByStream = new Map<string, number>()
    const totalByStream = new Map<string, number>()
    let total = 0
    for (const row of result.rows) {
      const mentions = Number(row.mention_count)
      const count = Number(row.total_count)
      if (mentions > 0) mentionsByStream.set(row.stream_id, mentions)
      totalByStream.set(row.stream_id, count)
      total += count
    }
    return { mentionsByStream, totalByStream, total }
  },

  /**
   * Unread counts for a batch of (user, stream) pairs in one set-based query
   * (INV-56). Keyed `${userId}:${streamId}`; pairs with no unread rows map to
   * zeros. Used to stamp absolute counts onto activity:created payloads.
   */
  async countUnreadForPairs(
    db: Querier,
    workspaceId: string,
    pairs: Array<{ userId: string; streamId: string }>
  ): Promise<Map<string, { mentionCount: number; totalCount: number }>> {
    if (pairs.length === 0) return new Map()

    const userIds = pairs.map((p) => p.userId)
    const streamIds = pairs.map((p) => p.streamId)
    const result = await db.query<{ user_id: string; stream_id: string; mention_count: string; total_count: string }>(
      sql`
      SELECT
        p.user_id,
        p.stream_id,
        COUNT(ua.id) FILTER (WHERE ua.activity_type = 'mention')::text AS mention_count,
        COUNT(ua.id)::text AS total_count
      FROM (
        SELECT DISTINCT user_id, stream_id
        FROM unnest(${userIds}::text[], ${streamIds}::text[]) AS pair(user_id, stream_id)
      ) p
      LEFT JOIN user_activity ua
        ON ua.user_id = p.user_id
        AND ua.stream_id = p.stream_id
        AND ua.workspace_id = ${workspaceId}
        AND ua.read_at IS NULL
        AND ua.is_self = FALSE
      GROUP BY p.user_id, p.stream_id
    `
    )

    const map = new Map<string, { mentionCount: number; totalCount: number }>()
    for (const row of result.rows) {
      map.set(`${row.user_id}:${row.stream_id}`, {
        mentionCount: Number(row.mention_count),
        totalCount: Number(row.total_count),
      })
    }
    return map
  },

  async countUnreadForStream(
    db: Querier,
    userId: string,
    workspaceId: string,
    streamId: string
  ): Promise<{ mentionCount: number; totalCount: number }> {
    const result = await db.query<{ mention_count: string; total_count: string }>(sql`
      SELECT
        COUNT(*) FILTER (WHERE activity_type = 'mention')::text AS mention_count,
        COUNT(*)::text AS total_count
      FROM user_activity
      WHERE user_id = ${userId}
        AND workspace_id = ${workspaceId}
        AND stream_id = ${streamId}
        AND read_at IS NULL
        AND is_self = FALSE
    `)

    const row = result.rows[0]
    return {
      mentionCount: Number(row?.mention_count ?? 0),
      totalCount: Number(row?.total_count ?? 0),
    }
  },

  async markAsRead(db: Querier, activityId: string, userId: string): Promise<void> {
    await db.query(sql`
      UPDATE user_activity
      SET read_at = NOW()
      WHERE id = ${activityId}
        AND user_id = ${userId}
        AND read_at IS NULL
    `)
  },

  async markStreamAsRead(db: Querier, userId: string, streamId: string): Promise<number> {
    const result = await db.query(sql`
      UPDATE user_activity
      SET read_at = NOW()
      WHERE user_id = ${userId}
        AND stream_id = ${streamId}
        AND read_at IS NULL
    `)
    return result.rowCount ?? 0
  },

  async markAllAsRead(db: Querier, userId: string, workspaceId: string): Promise<number> {
    const result = await db.query(sql`
      UPDATE user_activity
      SET read_at = NOW()
      WHERE user_id = ${userId}
        AND workspace_id = ${workspaceId}
        AND read_at IS NULL
    `)
    return result.rowCount ?? 0
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
