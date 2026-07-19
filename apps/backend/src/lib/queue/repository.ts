import type { Querier } from "../../db"
import { sql } from "../../db"

interface QueueMessageRow {
  id: string
  queue_name: string
  workspace_id: string
  payload: unknown
  process_after: Date | null
  inserted_at: Date
  claimed_at: Date | null
  claimed_by: string | null
  claimed_until: Date | null
  claimed_count: number
  failed_count: number
  last_error: string | null
  dlq_at: Date | null
  completed_at: Date | null
  cancelled_at: Date | null
}

export interface QueueMessage {
  id: string
  queueName: string
  workspaceId: string
  payload: unknown
  processAfter: Date | null
  insertedAt: Date
  claimedAt: Date | null
  claimedBy: string | null
  claimedUntil: Date | null
  claimedCount: number
  failedCount: number
  lastError: string | null
  dlqAt: Date | null
  completedAt: Date | null
  cancelledAt: Date | null
}

export interface InsertQueueMessageParams {
  id: string
  queueName: string
  workspaceId: string
  payload: unknown
  processAfter: Date
  insertedAt: Date
}

export interface ClaimNextParams {
  queueName: string
  workspaceId: string
  claimedBy: string
  claimedAt: Date
  claimedUntil: Date
  now: Date
}

export interface BatchRenewClaimsParams {
  messageIds: string[]
  claimedBy: string
  claimedUntil: Date
}

export interface CompleteParams {
  messageId: string
  claimedBy: string
  completedAt: Date
}

export interface FailParams {
  messageId: string
  claimedBy: string
  error: string
  processAfter: Date
  now: Date
}

export interface FailDlqParams {
  messageId: string
  claimedBy: string
  error: string
  dlqAt: Date
}

export interface UnDlqParams {
  messageId: string
  processAfter: Date
}

export type QueueRetentionCategory = "completed" | "cancelled" | "dlq"

export interface DeleteExpiredMessagesBatchParams {
  category: QueueRetentionCategory
  cutoff: Date
  limit: number
}

const RETENTION_COLUMN: Record<QueueRetentionCategory, "completed_at" | "cancelled_at" | "dlq_at"> = {
  completed: "completed_at",
  cancelled: "cancelled_at",
  dlq: "dlq_at",
}

function mapRowToMessage(row: QueueMessageRow): QueueMessage {
  return {
    id: row.id,
    queueName: row.queue_name,
    workspaceId: row.workspace_id,
    payload: row.payload,
    processAfter: row.process_after,
    insertedAt: row.inserted_at,
    claimedAt: row.claimed_at,
    claimedBy: row.claimed_by,
    claimedUntil: row.claimed_until,
    claimedCount: row.claimed_count,
    failedCount: row.failed_count,
    lastError: row.last_error,
    dlqAt: row.dlq_at,
    completedAt: row.completed_at,
    cancelledAt: row.cancelled_at,
  }
}

const SELECT_FIELDS = sql.raw(`
  id, queue_name, workspace_id, payload,
  process_after, inserted_at,
  claimed_at, claimed_by, claimed_until, claimed_count,
  failed_count, last_error,
  dlq_at, completed_at, cancelled_at
`)

export const QueueRepository = {
  async insert(db: Querier, params: InsertQueueMessageParams): Promise<QueueMessage> {
    const result = await db.query<QueueMessageRow>(
      sql`
        INSERT INTO queue_messages (
          id, queue_name, workspace_id, payload,
          process_after, inserted_at
        ) VALUES (
          ${params.id},
          ${params.queueName},
          ${params.workspaceId},
          ${JSON.stringify(params.payload)},
          ${params.processAfter},
          ${params.insertedAt}
        )
        RETURNING ${SELECT_FIELDS}
      `
    )
    return mapRowToMessage(result.rows[0])
  },

  async batchInsert(db: Querier, messages: InsertQueueMessageParams[]): Promise<QueueMessage[]> {
    if (messages.length === 0) {
      return []
    }

    const placeholders: string[] = []
    const values: unknown[] = []
    let idx = 1

    for (const msg of messages) {
      placeholders.push(`($${idx++}, $${idx++}, $${idx++}, $${idx++}::jsonb, $${idx++}, $${idx++})`)
      values.push(msg.id, msg.queueName, msg.workspaceId, JSON.stringify(msg.payload), msg.processAfter, msg.insertedAt)
    }

    const result = await db.query<QueueMessageRow>(
      `INSERT INTO queue_messages (
        id, queue_name, workspace_id, payload,
        process_after, inserted_at
      ) VALUES ${placeholders.join(", ")}
      ON CONFLICT (id) DO NOTHING
      RETURNING
        id, queue_name, workspace_id, payload,
        process_after, inserted_at,
        claimed_at, claimed_by, claimed_until, claimed_count,
        failed_count, last_error,
        dlq_at, completed_at, cancelled_at`,
      values
    )

    return result.rows.map(mapRowToMessage)
  },

  /** FOR UPDATE SKIP LOCKED ensures only one worker claims a given message. */
  async batchClaimMessages(db: Querier, params: ClaimNextParams & { limit: number }): Promise<QueueMessage[]> {
    const result = await db.query<QueueMessageRow>(
      sql`
        WITH selected AS (
          SELECT id
          FROM queue_messages
          WHERE queue_name = ${params.queueName}
            AND workspace_id = ${params.workspaceId}
            AND process_after <= ${params.now}
            AND (claimed_until IS NULL OR claimed_until < ${params.now})
            AND completed_at IS NULL
            AND cancelled_at IS NULL
            AND dlq_at IS NULL
          ORDER BY process_after ASC
          LIMIT ${params.limit}
          FOR UPDATE SKIP LOCKED
        )
        UPDATE queue_messages
        SET
          claimed_at = ${params.claimedAt},
          claimed_by = ${params.claimedBy},
          claimed_until = ${params.claimedUntil},
          claimed_count = claimed_count + 1
        FROM selected
        WHERE queue_messages.id = selected.id
        RETURNING
          queue_messages.id,
          queue_messages.queue_name,
          queue_messages.workspace_id,
          queue_messages.payload,
          queue_messages.process_after,
          queue_messages.inserted_at,
          queue_messages.claimed_at,
          queue_messages.claimed_by,
          queue_messages.claimed_until,
          queue_messages.claimed_count,
          queue_messages.failed_count,
          queue_messages.last_error,
          queue_messages.dlq_at,
          queue_messages.completed_at,
          queue_messages.cancelled_at
      `
    )

    const messages = result.rows.map(mapRowToMessage)
    messages.sort((a, b) => {
      // processAfter should never be null for claimed messages (only completed/DLQ have null)
      // but handle it for type safety
      if (!a.processAfter) return 1
      if (!b.processAfter) return -1
      return a.processAfter.getTime() - b.processAfter.getTime()
    })

    return messages
  },

  /**
   * Completed/cancelled/DLQ'd messages are skipped, so a renewal can partially
   * succeed while some messages in the batch finish independently.
   */
  async batchRenewClaims(db: Querier, params: BatchRenewClaimsParams): Promise<number> {
    const result = await db.query(
      sql`
        UPDATE queue_messages
        SET claimed_until = ${params.claimedUntil}
        WHERE id = ANY(${params.messageIds})
          AND claimed_by = ${params.claimedBy}
          AND completed_at IS NULL
          AND cancelled_at IS NULL
          AND dlq_at IS NULL
      `
    )

    return result.rowCount ?? 0
  },

  /** Verifies claimedBy so only the claiming worker completes the message. */
  async complete(db: Querier, params: CompleteParams): Promise<void> {
    const result = await db.query(
      sql`
        UPDATE queue_messages
        SET
          completed_at = ${params.completedAt},
          process_after = NULL,
          claimed_by = NULL,
          claimed_until = NULL
        WHERE id = ${params.messageId}
          AND claimed_by = ${params.claimedBy}
          AND completed_at IS NULL
      `
    )

    if ((result.rowCount ?? 0) === 0) {
      throw new Error(`Failed to complete message ${params.messageId}: not found or wrong claimedBy`)
    }
  },

  /**
   * Cancel a pending queue message. Used when the upstream domain entity no
   * longer needs the job (e.g. a saved message marked done — the pending
   * reminder should not fire).
   *
   * Skips rows that are actively claimed by a worker so we don't clobber the
   * worker's own completion path (which matches on claimed_by). When the
   * worker's handler runs, it is expected to re-check domain state and
   * no-op if the entity no longer warrants the job — then complete normally
   * with its claim intact.
   *
   * Returns true if a row was cancelled, false if it was missing, already
   * completed/cancelled, or in flight.
   */
  async cancelById(db: Querier, messageId: string): Promise<boolean> {
    const result = await db.query(
      sql`
        UPDATE queue_messages
        SET
          cancelled_at = NOW(),
          process_after = NULL
        WHERE id = ${messageId}
          AND completed_at IS NULL
          AND cancelled_at IS NULL
          AND claimed_by IS NULL
      `
    )
    return (result.rowCount ?? 0) > 0
  },

  /**
   * Record failure and set retry backoff (does NOT move to DLQ). Verifies
   * claimedBy so only the claiming worker records the failure.
   */
  async fail(db: Querier, params: FailParams): Promise<void> {
    const result = await db.query(
      sql`
        UPDATE queue_messages
        SET
          failed_count = failed_count + 1,
          last_error = ${params.error},
          process_after = ${params.processAfter},
          claimed_by = NULL,
          claimed_until = NULL
        WHERE id = ${params.messageId}
          AND claimed_by = ${params.claimedBy}
          AND completed_at IS NULL
          AND dlq_at IS NULL
      `
    )

    if ((result.rowCount ?? 0) === 0) {
      throw new Error(`Failed to record failure for message ${params.messageId}: not found or wrong claimedBy`)
    }
  },

  /** Verifies claimedBy so only the claiming worker moves the message to DLQ. */
  async failDlq(db: Querier, params: FailDlqParams): Promise<void> {
    const result = await db.query(
      sql`
        UPDATE queue_messages
        SET
          dlq_at = ${params.dlqAt},
          last_error = ${params.error},
          process_after = NULL,
          claimed_by = NULL,
          claimed_until = NULL
        WHERE id = ${params.messageId}
          AND claimed_by = ${params.claimedBy}
          AND completed_at IS NULL
          AND dlq_at IS NULL
      `
    )

    if ((result.rowCount ?? 0) === 0) {
      throw new Error(`Failed to move message ${params.messageId} to DLQ: not found or wrong claimedBy`)
    }
  },

  async unDlq(db: Querier, params: UnDlqParams): Promise<void> {
    const result = await db.query(
      sql`
        UPDATE queue_messages
        SET
          dlq_at = NULL,
          failed_count = 0,
          last_error = NULL,
          process_after = ${params.processAfter}
        WHERE id = ${params.messageId}
          AND dlq_at IS NOT NULL
      `
    )

    if ((result.rowCount ?? 0) === 0) {
      throw new Error(`Failed to un-DLQ message ${params.messageId}: not found or not in DLQ`)
    }
  },

  /**
   * Delete one batch (up to `limit`) of terminal messages in `category` whose
   * retention timestamp is older than `cutoff`. Returns rows deleted; callers
   * loop until it returns < limit. For completed/cancelled the `IS NOT NULL AND
   * < cutoff` predicate matches a single-column partial cleanup index, so the
   * ORDER BY + LIMIT is an ordered index descent. DLQ only has the composite
   * idx_queue_messages_dlq (queue_name, workspace_id, dlq_at), so its batch
   * sorts the whole partial index first — acceptable because the DLQ set stays
   * small by nature (exhausted-retry failures awaiting an operator).
   */
  async deleteExpiredMessagesBatch(db: Querier, params: DeleteExpiredMessagesBatchParams): Promise<number> {
    if (params.limit <= 0) {
      return 0
    }

    const column = sql.raw(RETENTION_COLUMN[params.category])
    const result = await db.query(
      sql`
        WITH candidates AS (
          SELECT id
          FROM queue_messages
          WHERE ${column} IS NOT NULL
            AND ${column} < ${params.cutoff}
          ORDER BY ${column}
          LIMIT ${params.limit}
        )
        DELETE FROM queue_messages
        USING candidates
        WHERE queue_messages.id = candidates.id
          -- Re-assert the terminal predicate: the CTE's filter is evaluated at
          -- statement snapshot, so a concurrent reactivation (unDlq) committing
          -- mid-statement would otherwise pass the id-only re-check and delete
          -- a now-live row.
          AND queue_messages.${column} IS NOT NULL
          AND queue_messages.${column} < ${params.cutoff}
      `
    )

    return result.rowCount ?? 0
  },

  /** For testing/debugging. */
  async getById(db: Querier, id: string): Promise<QueueMessage | null> {
    const result = await db.query<QueueMessageRow>(
      sql`
        SELECT ${SELECT_FIELDS}
        FROM queue_messages
        WHERE id = ${id}
      `
    )

    return result.rows[0] ? mapRowToMessage(result.rows[0]) : null
  },
}
