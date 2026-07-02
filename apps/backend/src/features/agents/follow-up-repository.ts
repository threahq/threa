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
   * Insert a pending follow-up only while the stream is below its pending cap.
   * The `WHERE (SELECT count …) < limit` guard makes the cap a single
   * statement rather than check-then-act (INV-20). Concurrent creates for the
   * same stream can't actually race — one persona session runs per stream at a
   * time and the tool executes inside that single session — but the guarded
   * insert keeps the invariant honest regardless.
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

  /** Read a row scoped to (workspace, id) per INV-8. */
  async findByIdScoped(db: Querier, workspaceId: string, id: string): Promise<AgentFollowUp | null> {
    const result = await db.query<AgentFollowUpRow>(sql`
      SELECT ${sql.raw(COLUMNS)} FROM agent_follow_ups
      WHERE id = ${id} AND workspace_id = ${workspaceId}
    `)
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },

  /**
   * CAS `pending → fired`. The status guard makes firing exactly-once: a stale
   * queue tick that lost the cancel race, or a duplicate delivery, finds the
   * row no longer pending and gets `null`.
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
