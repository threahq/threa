import type { Querier } from "../../db"
import { sql } from "../../db"
import { FollowUpStatuses, type FollowUpStatus } from "@threa/types"

interface AgentFollowUpRow {
  id: string
  workspace_id: string
  stream_id: string
  persona_id: string
  session_id: string
  source_conversation_id: string | null
  note: string
  scheduled_for: Date
  status: string
  queue_message_id: string | null
  last_error: string | null
  created_at: Date
  updated_at: Date
  status_changed_at: Date
}

export interface AgentFollowUp {
  id: string
  workspaceId: string
  streamId: string
  personaId: string
  sessionId: string
  sourceConversationId: string | null
  note: string
  scheduledFor: Date
  status: FollowUpStatus
  queueMessageId: string | null
  lastError: string | null
  createdAt: Date
  updatedAt: Date
  statusChangedAt: Date
}

export interface InsertAgentFollowUpParams {
  id: string
  workspaceId: string
  streamId: string
  personaId: string
  sessionId: string
  sourceConversationId: string | null
  note: string
  scheduledFor: Date
}

const COLUMNS = `
  id, workspace_id, stream_id, persona_id, session_id, source_conversation_id,
  note, scheduled_for, status, queue_message_id, last_error,
  created_at, updated_at, status_changed_at
`

function mapRow(row: AgentFollowUpRow): AgentFollowUp {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    streamId: row.stream_id,
    personaId: row.persona_id,
    sessionId: row.session_id,
    sourceConversationId: row.source_conversation_id,
    note: row.note,
    scheduledFor: row.scheduled_for,
    status: row.status as FollowUpStatus,
    queueMessageId: row.queue_message_id,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    statusChangedAt: row.status_changed_at,
  }
}

export const AgentFollowUpRepository = {
  /**
   * Take a transaction-scoped advisory lock keyed on (workspace, stream) so the
   * count-guarded insert below runs serially per stream. The caller holds this
   * for the whole create transaction; it releases on commit/rollback.
   */
  async acquireStreamCapLock(db: Querier, workspaceId: string, streamId: string): Promise<void> {
    await db.query(sql`SELECT pg_advisory_xact_lock(hashtext(${workspaceId}), hashtext(${streamId}))`)
  },

  /**
   * Insert a pending follow-up only while the stream is below its pending cap.
   * The `WHERE (SELECT count …) < limit` guard keeps the cap a single statement
   * (INV-20), and `acquireStreamCapLock` serializes concurrent creates for the
   * stream so the count is exact rather than a lost-update race.
   *
   * Returns the inserted row, or `null` when the cap is already met (no row
   * written).
   */
  async insertIfUnderCap(db: Querier, params: InsertAgentFollowUpParams, limit: number): Promise<AgentFollowUp | null> {
    const result = await db.query<AgentFollowUpRow>(sql`
      INSERT INTO agent_follow_ups (
        id, workspace_id, stream_id, persona_id, session_id,
        source_conversation_id, note, scheduled_for, status
      )
      SELECT
        ${params.id},
        ${params.workspaceId},
        ${params.streamId},
        ${params.personaId},
        ${params.sessionId},
        ${params.sourceConversationId},
        ${params.note},
        ${params.scheduledFor},
        ${FollowUpStatuses.PENDING}
      WHERE (
        SELECT count(*) FROM agent_follow_ups
        WHERE workspace_id = ${params.workspaceId}
          AND stream_id = ${params.streamId}
          AND status = ${FollowUpStatuses.PENDING}
      ) < ${limit}
      RETURNING ${sql.raw(COLUMNS)}
    `)
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },

  /** Read a single follow-up by id, workspace-scoped (INV-8). */
  async findById(db: Querier, workspaceId: string, id: string): Promise<AgentFollowUp | null> {
    const result = await db.query<AgentFollowUpRow>(sql`
      SELECT ${sql.raw(COLUMNS)} FROM agent_follow_ups
      WHERE id = ${id} AND workspace_id = ${workspaceId}
    `)
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },

  /**
   * List a stream's pending follow-ups, soonest first (INV-8 workspace-scoped).
   * Backs the agent's `list_follow_ups` tool: only pending rows are actionable
   * (a fired/cancelled one can't be cancelled or rescheduled).
   */
  async listPending(db: Querier, workspaceId: string, streamId: string): Promise<AgentFollowUp[]> {
    const result = await db.query<AgentFollowUpRow>(sql`
      SELECT ${sql.raw(COLUMNS)} FROM agent_follow_ups
      WHERE workspace_id = ${workspaceId}
        AND stream_id = ${streamId}
        AND status = ${FollowUpStatuses.PENDING}
      ORDER BY scheduled_for ASC
    `)
    return result.rows.map(mapRow)
  },

  /** Count pending follow-ups for a stream (INV-8 workspace-scoped). */
  async countPending(db: Querier, workspaceId: string, streamId: string): Promise<number> {
    const result = await db.query<{ count: string }>(sql`
      SELECT count(*)::int AS count FROM agent_follow_ups
      WHERE workspace_id = ${workspaceId}
        AND stream_id = ${streamId}
        AND status = ${FollowUpStatuses.PENDING}
    `)
    return Number(result.rows[0]?.count ?? 0)
  },

  async setQueueMessageId(db: Querier, workspaceId: string, id: string, queueMessageId: string | null): Promise<void> {
    await db.query(sql`
      UPDATE agent_follow_ups SET
        queue_message_id = ${queueMessageId},
        updated_at = NOW()
      WHERE id = ${id} AND workspace_id = ${workspaceId}
    `)
  },

  /**
   * CAS `pending → fired`. The status guard makes firing exactly-once: a stale
   * queue tick that lost the cancel race, or a duplicate delivery, finds the
   * row no longer pending and gets `null`.
   *
   * The `scheduled_for <= NOW()` guard is load-bearing for reschedule: it is a
   * no-op on the normal path (the fire job's `processAfter` equals
   * `scheduled_for`, so the queue never delivers before it), but if a
   * reschedule-to-later races an already-leased old fire job, that stale tick
   * finds the row's new time still in the future and no-ops instead of firing
   * early. The freshly enqueued job fires it at the new time.
   */
  async markFired(db: Querier, workspaceId: string, id: string): Promise<AgentFollowUp | null> {
    const result = await db.query<AgentFollowUpRow>(sql`
      UPDATE agent_follow_ups SET
        status = ${FollowUpStatuses.FIRED},
        status_changed_at = NOW(),
        updated_at = NOW()
      WHERE id = ${id}
        AND workspace_id = ${workspaceId}
        AND status = ${FollowUpStatuses.PENDING}
        AND scheduled_for <= NOW()
      RETURNING ${sql.raw(COLUMNS)}
    `)
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },

  /**
   * CAS `pending → cancelled`. Returns `null` when the row already fired (or was
   * cancelled) — the cancel lost the race and the caller reports it.
   */
  async markCancelled(db: Querier, workspaceId: string, id: string): Promise<AgentFollowUp | null> {
    const result = await db.query<AgentFollowUpRow>(sql`
      UPDATE agent_follow_ups SET
        status = ${FollowUpStatuses.CANCELLED},
        status_changed_at = NOW(),
        updated_at = NOW()
      WHERE id = ${id}
        AND workspace_id = ${workspaceId}
        AND status = ${FollowUpStatuses.PENDING}
      RETURNING ${sql.raw(COLUMNS)}
    `)
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },

  /**
   * CAS `pending → cancelled`, additionally scoped to `streamId` — the
   * agent-admin `cancel_follow_up` path, so a turn in one stream can only cancel
   * its own stream's follow-ups. Same exactly-once semantics as `markCancelled`.
   */
  async markCancelledInStream(
    db: Querier,
    workspaceId: string,
    streamId: string,
    id: string
  ): Promise<AgentFollowUp | null> {
    const result = await db.query<AgentFollowUpRow>(sql`
      UPDATE agent_follow_ups SET
        status = ${FollowUpStatuses.CANCELLED},
        status_changed_at = NOW(),
        updated_at = NOW()
      WHERE id = ${id}
        AND workspace_id = ${workspaceId}
        AND stream_id = ${streamId}
        AND status = ${FollowUpStatuses.PENDING}
      RETURNING ${sql.raw(COLUMNS)}
    `)
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },

  /**
   * CAS-update a pending follow-up's note + scheduled time, stream-scoped (the
   * agent-admin `update_follow_up` path). Sets both columns unconditionally — the
   * service coalesces unspecified fields to the existing values first — so this
   * stays a single statement. `status_changed_at` is left untouched (the status
   * doesn't change). Returns `null` when the row is no longer pending (lost the
   * race to fire/cancel) or isn't in this stream.
   */
  async updatePending(
    db: Querier,
    params: { workspaceId: string; streamId: string; id: string; note: string; scheduledFor: Date }
  ): Promise<AgentFollowUp | null> {
    const result = await db.query<AgentFollowUpRow>(sql`
      UPDATE agent_follow_ups SET
        note = ${params.note},
        scheduled_for = ${params.scheduledFor},
        updated_at = NOW()
      WHERE id = ${params.id}
        AND workspace_id = ${params.workspaceId}
        AND stream_id = ${params.streamId}
        AND status = ${FollowUpStatuses.PENDING}
      RETURNING ${sql.raw(COLUMNS)}
    `)
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },

  /** CAS to `failed` from pending/fired when the fire path errors terminally. */
  async markFailed(db: Querier, workspaceId: string, id: string, reason: string): Promise<AgentFollowUp | null> {
    const result = await db.query<AgentFollowUpRow>(sql`
      UPDATE agent_follow_ups SET
        status = ${FollowUpStatuses.FAILED},
        last_error = ${reason},
        status_changed_at = NOW(),
        updated_at = NOW()
      WHERE id = ${id}
        AND workspace_id = ${workspaceId}
        AND status IN (${FollowUpStatuses.PENDING}, ${FollowUpStatuses.FIRED})
      RETURNING ${sql.raw(COLUMNS)}
    `)
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },
}
