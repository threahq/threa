import type { Querier } from "../../db"
import { sql } from "../../db"
import { isUniqueViolation } from "../../lib/errors"
import { SubagentStatuses, type SubagentFailureReason, type SubagentStatus } from "@threa/types"

interface SubagentRunRow {
  id: string
  workspace_id: string
  parent_stream_id: string
  scope_stream_id: string
  parent_session_id: string | null
  trigger_message_id: string | null
  card_event_id: string
  thread_stream_id: string
  persona_id: string
  model: string
  created_by: string
  title: string
  brief: string
  status: string
  status_note: string | null
  result_message_id: string | null
  created_at: Date
  updated_at: Date
  status_changed_at: Date
}

export interface SubagentRun {
  id: string
  workspaceId: string
  parentStreamId: string
  /**
   * The conversation surface the one-live-subagent rule applies to: the parent's
   * root, or the parent itself when it is not a thread. A channel mention posts
   * its card in the reply thread, so scoping the rule to the immediate parent
   * would allow one live subagent per mention thread.
   */
  scopeStreamId: string
  parentSessionId: string | null
  triggerMessageId: string | null
  cardEventId: string
  threadStreamId: string
  personaId: string
  model: string
  createdBy: string
  title: string
  brief: string
  status: SubagentStatus
  statusNote: string | null
  resultMessageId: string | null
  createdAt: Date
  updatedAt: Date
  statusChangedAt: Date
}

export interface InsertSubagentRunParams {
  id: string
  workspaceId: string
  parentStreamId: string
  scopeStreamId: string
  parentSessionId: string | null
  triggerMessageId: string | null
  cardEventId: string
  threadStreamId: string
  personaId: string
  model: string
  createdBy: string
  title: string
  brief: string
}

/**
 * The partial unique index `(scope_stream_id) WHERE status = 'active'` rejected
 * the write: this conversation surface already has a live subagent. Typed so
 * the tool and the requeue endpoint can tell the model/user "one at a time"
 * instead of surfacing a raw Postgres error (INV-11 — the refusal is explicit,
 * not a silent no-op).
 */
export class SubagentAlreadyActiveError extends Error {
  readonly code = "SUBAGENT_ALREADY_ACTIVE"

  constructor(readonly scopeStreamId: string) {
    super(`A subagent is already active for scope ${scopeStreamId}`)
    this.name = "SubagentAlreadyActiveError"
  }
}

const COLUMNS = `
  id, workspace_id, parent_stream_id, scope_stream_id, parent_session_id, trigger_message_id,
  card_event_id, thread_stream_id, persona_id, model, created_by,
  title, brief, status, status_note, result_message_id,
  created_at, updated_at, status_changed_at
`

function mapRow(row: SubagentRunRow): SubagentRun {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    parentStreamId: row.parent_stream_id,
    scopeStreamId: row.scope_stream_id,
    parentSessionId: row.parent_session_id,
    triggerMessageId: row.trigger_message_id,
    cardEventId: row.card_event_id,
    threadStreamId: row.thread_stream_id,
    personaId: row.persona_id,
    model: row.model,
    createdBy: row.created_by,
    title: row.title,
    brief: row.brief,
    status: row.status as SubagentStatus,
    statusNote: row.status_note,
    resultMessageId: row.result_message_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    statusChangedAt: row.status_changed_at,
  }
}

/**
 * Every transition here CASes on `status = 'active'` and nothing else: a run has
 * one live state and four terminal ones, so a losing racer matches no row and
 * returns `null` rather than clobbering a settled outcome (INV-20). The single
 * `active` slot per conversation surface is the partial unique index's job, not
 * a read-then-write guard.
 */
export const SubagentRunRepository = {
  async insert(db: Querier, params: InsertSubagentRunParams): Promise<SubagentRun> {
    try {
      const result = await db.query<SubagentRunRow>(sql`
        INSERT INTO subagent_runs (
          id, workspace_id, parent_stream_id, scope_stream_id, parent_session_id, trigger_message_id,
          card_event_id, thread_stream_id, persona_id, model, created_by, title, brief, status
        ) VALUES (
          ${params.id}, ${params.workspaceId}, ${params.parentStreamId}, ${params.scopeStreamId}, ${params.parentSessionId},
          ${params.triggerMessageId}, ${params.cardEventId}, ${params.threadStreamId}, ${params.personaId},
          ${params.model}, ${params.createdBy}, ${params.title}, ${params.brief}, ${SubagentStatuses.ACTIVE}
        )
        RETURNING ${sql.raw(COLUMNS)}
      `)
      return mapRow(result.rows[0])
    } catch (error) {
      if (isUniqueViolation(error)) throw new SubagentAlreadyActiveError(params.scopeStreamId)
      throw error
    }
  },

  async findById(db: Querier, workspaceId: string, id: string): Promise<SubagentRun | null> {
    const result = await db.query<SubagentRunRow>(sql`
      SELECT ${sql.raw(COLUMNS)} FROM subagent_runs
      WHERE id = ${id} AND workspace_id = ${workspaceId}
    `)
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },

  /**
   * The live run a turn in this thread is bound to — the pinned-model lookup on
   * the persona-turn precheck, and the wake gate in the companion handler.
   * Workspace-scoped like every other read (INV-8).
   */
  async findActiveByThreadStreamId(
    db: Querier,
    workspaceId: string,
    threadStreamId: string
  ): Promise<SubagentRun | null> {
    const result = await db.query<SubagentRunRow>(sql`
      SELECT ${sql.raw(COLUMNS)} FROM subagent_runs
      WHERE thread_stream_id = ${threadStreamId}
        AND workspace_id = ${workspaceId}
        AND status = ${SubagentStatuses.ACTIVE}
    `)
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },

  /** CAS `active → completed`, linking the message the subagent reported back with. */
  async complete(
    db: Querier,
    params: { workspaceId: string; id: string; resultMessageId: string | null }
  ): Promise<SubagentRun | null> {
    return casToTerminal(db, {
      workspaceId: params.workspaceId,
      id: params.id,
      status: SubagentStatuses.COMPLETED,
      statusNote: null,
      resultMessageId: params.resultMessageId,
    })
  },

  /** CAS `active → cancelled` — a person stopping the run from the card. */
  async cancel(
    db: Querier,
    params: { workspaceId: string; id: string; parentStreamId?: string }
  ): Promise<SubagentRun | null> {
    return casToTerminal(db, {
      workspaceId: params.workspaceId,
      id: params.id,
      parentStreamId: params.parentStreamId,
      status: SubagentStatuses.CANCELLED,
      statusNote: null,
      resultMessageId: null,
    })
  },

  /**
   * Same read, `FOR UPDATE` — for transactions that go on to append a patch
   * naming this row's status. Without the lock a cancel can commit between the
   * read and the patch, leaving an `active` patch sequenced AFTER the terminal
   * one and a card that says "waiting for you" about a cancelled run.
   */
  async lockActiveByThreadStreamId(
    db: Querier,
    workspaceId: string,
    threadStreamId: string
  ): Promise<SubagentRun | null> {
    const result = await db.query<SubagentRunRow>(sql`
      SELECT ${sql.raw(COLUMNS)} FROM subagent_runs
      WHERE thread_stream_id = ${threadStreamId}
        AND workspace_id = ${workspaceId}
        AND status = ${SubagentStatuses.ACTIVE}
      FOR UPDATE
    `)
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },

  /**
   * CAS `active → failed` for whichever run owns this thread — the session
   * failure path knows the stream it died in, never the run id. Returns `null`
   * when the thread has no live run (the ordinary case for every other stream).
   * `runId` pins the CAS to the run the caller observed. A requeue re-activates
   * the same row, so this does not distinguish a run from its own restart — a
   * kickoff job that outlives a fail → requeue can still settle the restart.
   */
  async failByThreadStreamId(
    db: Querier,
    params: { workspaceId: string; threadStreamId: string; reason: SubagentFailureReason; runId?: string }
  ): Promise<SubagentRun | null> {
    const result = await db.query<SubagentRunRow>(sql`
      UPDATE subagent_runs SET
        status = ${SubagentStatuses.FAILED},
        status_note = ${params.reason},
        status_changed_at = NOW(),
        updated_at = NOW()
      WHERE thread_stream_id = ${params.threadStreamId}
        AND workspace_id = ${params.workspaceId}
        AND status = ${SubagentStatuses.ACTIVE}
        AND (${params.runId ?? null}::text IS NULL OR id = ${params.runId ?? null})
      RETURNING ${sql.raw(COLUMNS)}
    `)
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },

  /**
   * Set-based expiry (INV-56): CAS every idle `active` run to `expired` in one
   * statement and return the affected rows so the sweep appends their status
   * patches in the same transaction. Concurrent sweeps are idempotent — the
   * second matches nothing.
   */
  async expireIdle(db: Querier, params: { idleDays: number; limit: number }): Promise<SubagentRun[]> {
    // Bounded per pass so a post-downtime backlog can't turn one sweep
    // transaction into an unbounded per-card event loop; the hourly sweep
    // drains the remainder on later passes. The CAS on `status` keeps a row
    // selected by two concurrent sweeps single-transition.
    const result = await db.query<SubagentRunRow>(sql`
      UPDATE subagent_runs SET
        status = ${SubagentStatuses.EXPIRED},
        status_note = NULL,
        status_changed_at = NOW(),
        updated_at = NOW()
      WHERE status = ${SubagentStatuses.ACTIVE}
        AND id IN (
          SELECT id FROM subagent_runs
          WHERE status = ${SubagentStatuses.ACTIVE}
            AND updated_at <= NOW() - (${params.idleDays} || ' days')::interval
          LIMIT ${params.limit}
        )
      RETURNING ${sql.raw(COLUMNS)}
    `)
    return result.rows.map(mapRow)
  },

  /**
   * Stamp activity on a live run so the idle sweep measures silence, not age:
   * `updated_at` is the row's last write, and the subagent speaking is one.
   */
  async touchActive(db: Querier, params: { workspaceId: string; id: string }): Promise<void> {
    await db.query(sql`
      UPDATE subagent_runs SET updated_at = NOW()
      WHERE id = ${params.id}
        AND workspace_id = ${params.workspaceId}
        AND status = ${SubagentStatuses.ACTIVE}
    `)
  },

  /**
   * CAS a settled run back to `active` — "Try again" on a failed or expired
   * card. Races the partial unique index exactly like `insert`: if another
   * subagent took the stream's live slot meanwhile, the write raises a unique
   * violation and surfaces as {@link SubagentAlreadyActiveError}.
   */
  async requeue(
    db: Querier,
    params: { workspaceId: string; id: string; scopeStreamId: string }
  ): Promise<SubagentRun | null> {
    try {
      const result = await db.query<SubagentRunRow>(sql`
        UPDATE subagent_runs SET
          status = ${SubagentStatuses.ACTIVE},
          status_note = NULL,
          result_message_id = NULL,
          status_changed_at = NOW(),
          updated_at = NOW()
        WHERE id = ${params.id}
          AND workspace_id = ${params.workspaceId}
          AND scope_stream_id = ${params.scopeStreamId}
          AND status IN (${SubagentStatuses.FAILED}, ${SubagentStatuses.EXPIRED})
        RETURNING ${sql.raw(COLUMNS)}
      `)
      return result.rows[0] ? mapRow(result.rows[0]) : null
    } catch (error) {
      if (isUniqueViolation(error)) throw new SubagentAlreadyActiveError(params.scopeStreamId)
      throw error
    }
  },
}

async function casToTerminal(
  db: Querier,
  params: {
    workspaceId: string
    id: string
    parentStreamId?: string
    status: SubagentStatus
    statusNote: string | null
    resultMessageId: string | null
  }
): Promise<SubagentRun | null> {
  const result = await db.query<SubagentRunRow>(sql`
    UPDATE subagent_runs SET
      status = ${params.status},
      status_note = ${params.statusNote},
      result_message_id = COALESCE(${params.resultMessageId}::text, result_message_id),
      status_changed_at = NOW(),
      updated_at = NOW()
    WHERE id = ${params.id}
      AND workspace_id = ${params.workspaceId}
      AND (${params.parentStreamId ?? null}::text IS NULL OR parent_stream_id = ${params.parentStreamId ?? null})
      AND status = ${SubagentStatuses.ACTIVE}
    RETURNING ${sql.raw(COLUMNS)}
  `)
  return result.rows[0] ? mapRow(result.rows[0]) : null
}
