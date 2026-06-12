import type { Querier } from "../../db"
import { sql } from "../../db"
import { savedMessageId } from "../../lib/id"
import { SavedStatuses, type SavedStatus } from "@threa/types"

interface SavedMessageRow {
  id: string
  workspace_id: string
  user_id: string
  message_id: string | null
  stream_id: string | null
  status: string
  title: string | null
  note: string | null
  remind_at: Date | null
  reminder_sent_at: Date | null
  reminder_queue_message_id: string | null
  saved_at: Date
  status_changed_at: Date
  created_at: Date
  updated_at: Date
}

/**
 * A saved item: either anchored to a message (`messageId`/`streamId` set) or
 * a standalone to-do (`messageId`/`streamId` null, `title` set).
 */
export interface SavedMessage {
  id: string
  workspaceId: string
  userId: string
  messageId: string | null
  streamId: string | null
  status: SavedStatus
  title: string | null
  note: string | null
  remindAt: Date | null
  reminderSentAt: Date | null
  reminderQueueMessageId: string | null
  savedAt: Date
  statusChangedAt: Date
  createdAt: Date
  updatedAt: Date
}

export interface UpsertSavedParams {
  workspaceId: string
  userId: string
  messageId: string
  streamId: string
  remindAt: Date | null
}

export interface InsertStandaloneParams {
  workspaceId: string
  userId: string
  title: string
  note: string | null
  remindAt: Date | null
}

export interface SavedUpsertResult {
  saved: SavedMessage
  /** True if a new row was inserted; false if an existing row was updated. */
  inserted: boolean
  /**
   * Previous reminder queue message id if the upsert overwrote an existing
   * pending reminder. Callers use this to cancel the old queue row.
   * Null when there was no previous queue row.
   */
  previousReminderQueueMessageId: string | null
}

export interface ListSavedOpts {
  status: SavedStatus
  limit?: number
  cursor?: string
}

const SAVED_MESSAGE_COLUMNS =
  "id, workspace_id, user_id, message_id, stream_id, status, title, note, remind_at, reminder_sent_at, reminder_queue_message_id, saved_at, status_changed_at, created_at, updated_at"

function mapRow(row: SavedMessageRow): SavedMessage {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    userId: row.user_id,
    messageId: row.message_id,
    streamId: row.stream_id,
    status: row.status as SavedStatus,
    title: row.title,
    note: row.note,
    remindAt: row.remind_at,
    reminderSentAt: row.reminder_sent_at,
    reminderQueueMessageId: row.reminder_queue_message_id,
    savedAt: row.saved_at,
    statusChangedAt: row.status_changed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export const SavedMessagesRepository = {
  /**
   * Race-safe upsert (INV-20). If a row exists for (workspace, user, message):
   *   - resets status to 'saved'
   *   - updates remind_at (null clears it)
   *   - clears reminder_sent_at so a new reminder can fire
   *   - if previous status was done/archived, bumps saved_at and status_changed_at to NOW()
   *     so the row surfaces at the top of the Saved tab
   *   - clears reminder_queue_message_id so the service cancels the old queue row
   *
   * The `old` CTE captures the pre-update reminder_queue_message_id because
   * RETURNING on INSERT ... ON CONFLICT DO UPDATE reads post-update values,
   * and the UPDATE clause nulls that column. Without the CTE, the caller would
   * never see the previous queue id and could not cancel the stale reminder.
   */
  async upsert(db: Querier, params: UpsertSavedParams): Promise<SavedUpsertResult> {
    const id = savedMessageId()
    const result = await db.query<
      SavedMessageRow & { inserted: boolean; previous_reminder_queue_message_id: string | null }
    >(sql`
      WITH old AS (
        SELECT reminder_queue_message_id
        FROM saved_messages
        WHERE workspace_id = ${params.workspaceId}
          AND user_id = ${params.userId}
          AND message_id = ${params.messageId}
      )
      INSERT INTO saved_messages (
        id, workspace_id, user_id, message_id, stream_id, status, remind_at
      )
      VALUES (
        ${id},
        ${params.workspaceId},
        ${params.userId},
        ${params.messageId},
        ${params.streamId},
        ${SavedStatuses.SAVED},
        ${params.remindAt}
      )
      ON CONFLICT (workspace_id, user_id, message_id) WHERE message_id IS NOT NULL DO UPDATE SET
        status = ${SavedStatuses.SAVED},
        remind_at = EXCLUDED.remind_at,
        reminder_sent_at = NULL,
        reminder_queue_message_id = NULL,
        saved_at = CASE
          WHEN saved_messages.status <> ${SavedStatuses.SAVED} THEN NOW()
          ELSE saved_messages.saved_at
        END,
        status_changed_at = CASE
          WHEN saved_messages.status <> ${SavedStatuses.SAVED} THEN NOW()
          ELSE saved_messages.status_changed_at
        END,
        updated_at = NOW()
      RETURNING
        ${sql.raw(SAVED_MESSAGE_COLUMNS)},
        (xmax = 0) AS inserted,
        (SELECT reminder_queue_message_id FROM old) AS previous_reminder_queue_message_id
    `)
    const row = result.rows[0]!
    return {
      saved: mapRow(row),
      inserted: row.inserted,
      previousReminderQueueMessageId: row.previous_reminder_queue_message_id,
    }
  },

  /**
   * Insert a standalone (message-less) saved item. No conflict target — the
   * partial unique index only covers message-anchored rows, so a user can
   * hold any number of standalone to-dos.
   */
  async insertStandalone(db: Querier, params: InsertStandaloneParams): Promise<SavedMessage> {
    const id = savedMessageId()
    const result = await db.query<SavedMessageRow>(sql`
      INSERT INTO saved_messages (
        id, workspace_id, user_id, status, title, note, remind_at
      )
      VALUES (
        ${id},
        ${params.workspaceId},
        ${params.userId},
        ${SavedStatuses.SAVED},
        ${params.title},
        ${params.note},
        ${params.remindAt}
      )
      RETURNING ${sql.raw(SAVED_MESSAGE_COLUMNS)}
    `)
    return mapRow(result.rows[0]!)
  },

  /**
   * Update title and/or note. Undefined fields are left untouched; `note`
   * accepts null to clear. A single guarded UPDATE (INV-20) — no
   * select-then-update.
   */
  async updateContent(
    db: Querier,
    workspaceId: string,
    userId: string,
    savedId: string,
    params: { title?: string; note?: string | null }
  ): Promise<SavedMessage | null> {
    const setTitle = params.title !== undefined
    const setNote = params.note !== undefined
    const result = await db.query<SavedMessageRow>(sql`
      UPDATE saved_messages SET
        title = CASE WHEN ${setTitle} THEN ${params.title ?? null} ELSE title END,
        note = CASE WHEN ${setNote} THEN ${params.note ?? null} ELSE note END,
        updated_at = NOW()
      WHERE id = ${savedId}
        AND workspace_id = ${workspaceId}
        AND user_id = ${userId}
      RETURNING ${sql.raw(SAVED_MESSAGE_COLUMNS)}
    `)
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },

  async findById(db: Querier, workspaceId: string, userId: string, savedId: string): Promise<SavedMessage | null> {
    const result = await db.query<SavedMessageRow>(sql`
      SELECT ${sql.raw(SAVED_MESSAGE_COLUMNS)}
      FROM saved_messages
      WHERE id = ${savedId} AND workspace_id = ${workspaceId} AND user_id = ${userId}
    `)
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },

  /** Worker-scoped lookup — no user_id filter; used by the reminder worker. */
  async findByIdUnscoped(db: Querier, savedId: string): Promise<SavedMessage | null> {
    const result = await db.query<SavedMessageRow>(sql`
      SELECT ${sql.raw(SAVED_MESSAGE_COLUMNS)}
      FROM saved_messages
      WHERE id = ${savedId}
    `)
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },

  async findByMessageId(
    db: Querier,
    workspaceId: string,
    userId: string,
    messageId: string
  ): Promise<SavedMessage | null> {
    const result = await db.query<SavedMessageRow>(sql`
      SELECT ${sql.raw(SAVED_MESSAGE_COLUMNS)}
      FROM saved_messages
      WHERE workspace_id = ${workspaceId}
        AND user_id = ${userId}
        AND message_id = ${messageId}
    `)
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },

  async findByMessageIds(
    db: Querier,
    workspaceId: string,
    userId: string,
    messageIds: string[]
  ): Promise<SavedMessage[]> {
    if (messageIds.length === 0) return []
    const result = await db.query<SavedMessageRow>(sql`
      SELECT ${sql.raw(SAVED_MESSAGE_COLUMNS)}
      FROM saved_messages
      WHERE workspace_id = ${workspaceId}
        AND user_id = ${userId}
        AND message_id = ANY(${messageIds}::text[])
    `)
    return result.rows.map(mapRow)
  },

  /**
   * List saved rows for a user filtered by status. Saved tab orders by
   * saved_at DESC; Done and Archived tabs order by status_changed_at DESC.
   */
  async listByUser(db: Querier, workspaceId: string, userId: string, opts: ListSavedOpts): Promise<SavedMessage[]> {
    const limit = opts.limit ?? 50
    const hasCursor = opts.cursor !== undefined
    const cursor = opts.cursor ?? ""
    const useSavedAt = opts.status === SavedStatuses.SAVED

    if (useSavedAt) {
      const result = await db.query<SavedMessageRow>(sql`
        SELECT ${sql.raw(SAVED_MESSAGE_COLUMNS)}
        FROM saved_messages
        WHERE workspace_id = ${workspaceId}
          AND user_id = ${userId}
          AND status = ${opts.status}
          AND (${!hasCursor} OR saved_at < (
            SELECT saved_at FROM saved_messages
            WHERE id = ${cursor} AND workspace_id = ${workspaceId} AND user_id = ${userId}
          ))
        ORDER BY saved_at DESC
        LIMIT ${limit}
      `)
      return result.rows.map(mapRow)
    }

    const result = await db.query<SavedMessageRow>(sql`
      SELECT ${sql.raw(SAVED_MESSAGE_COLUMNS)}
      FROM saved_messages
      WHERE workspace_id = ${workspaceId}
        AND user_id = ${userId}
        AND status = ${opts.status}
        AND (${!hasCursor} OR status_changed_at < (
          SELECT status_changed_at FROM saved_messages
          WHERE id = ${cursor} AND workspace_id = ${workspaceId} AND user_id = ${userId}
        ))
      ORDER BY status_changed_at DESC
      LIMIT ${limit}
    `)
    return result.rows.map(mapRow)
  },

  /**
   * Transition status. Bumps status_changed_at whenever status actually changes.
   * Returns the updated row, or null if the row doesn't exist or isn't owned
   * by the user.
   */
  async updateStatus(
    db: Querier,
    workspaceId: string,
    userId: string,
    savedId: string,
    newStatus: SavedStatus
  ): Promise<SavedMessage | null> {
    const result = await db.query<SavedMessageRow>(sql`
      UPDATE saved_messages SET
        status = ${newStatus},
        status_changed_at = CASE
          WHEN status <> ${newStatus} THEN NOW()
          ELSE status_changed_at
        END,
        updated_at = NOW()
      WHERE id = ${savedId}
        AND workspace_id = ${workspaceId}
        AND user_id = ${userId}
      RETURNING ${sql.raw(SAVED_MESSAGE_COLUMNS)}
    `)
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },

  /**
   * Set or clear the reminder and its queue-message pointer. Clears
   * reminder_sent_at so a new reminder can fire if the user re-schedules
   * after the original fired.
   */
  async updateReminder(
    db: Querier,
    workspaceId: string,
    userId: string,
    savedId: string,
    params: { remindAt: Date | null; queueMessageId: string | null }
  ): Promise<SavedMessage | null> {
    const result = await db.query<SavedMessageRow>(sql`
      UPDATE saved_messages SET
        remind_at = ${params.remindAt},
        reminder_queue_message_id = ${params.queueMessageId},
        reminder_sent_at = NULL,
        updated_at = NOW()
      WHERE id = ${savedId}
        AND workspace_id = ${workspaceId}
        AND user_id = ${userId}
      RETURNING ${sql.raw(SAVED_MESSAGE_COLUMNS)}
    `)
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },

  /**
   * Idempotent reminder-sent marker used by the worker. The
   * `reminder_sent_at IS NULL` predicate ensures at-most-once fire even if the
   * queue re-delivers a claimed message. Returns the updated row so callers
   * can build outbox payloads without a second SELECT; null when the update
   * was a no-op (already sent, not in saved status, or missing).
   */
  async markReminderSent(db: Querier, savedId: string, sentAt: Date): Promise<SavedMessage | null> {
    const result = await db.query<SavedMessageRow>(sql`
      UPDATE saved_messages SET
        reminder_sent_at = ${sentAt},
        updated_at = NOW()
      WHERE id = ${savedId}
        AND reminder_sent_at IS NULL
        AND status = ${SavedStatuses.SAVED}
      RETURNING ${sql.raw(SAVED_MESSAGE_COLUMNS)}
    `)
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },

  async delete(db: Querier, workspaceId: string, userId: string, savedId: string): Promise<boolean> {
    const result = await db.query(sql`
      DELETE FROM saved_messages
      WHERE id = ${savedId}
        AND workspace_id = ${workspaceId}
        AND user_id = ${userId}
    `)
    return (result.rowCount ?? 0) > 0
  },
}
