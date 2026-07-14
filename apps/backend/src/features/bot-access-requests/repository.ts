import type { Querier } from "../../db"
import { sql } from "../../db"
import { BotAccessRequestStatuses, type BotAccessRequestStatus } from "@threa/types"

interface BotAccessRequestRow {
  id: string
  workspace_id: string
  bot_id: string
  stream_id: string
  delegation_id: string | null
  bot_name: string
  delegation_title: string | null
  requested_by_label: string | null
  status: string
  resolved_by: string | null
  created_at: Date
  updated_at: Date
  status_changed_at: Date
}

export interface BotAccessRequest {
  id: string
  workspaceId: string
  botId: string
  streamId: string
  delegationId: string | null
  botName: string
  delegationTitle: string | null
  requestedByLabel: string | null
  status: BotAccessRequestStatus
  resolvedBy: string | null
  createdAt: Date
  updatedAt: Date
  statusChangedAt: Date
}

export interface InsertBotAccessRequestParams {
  id: string
  workspaceId: string
  botId: string
  streamId: string
  delegationId: string | null
  botName: string
  delegationTitle: string | null
  requestedByLabel: string | null
}

const COLUMNS = `
  id, workspace_id, bot_id, stream_id, delegation_id,
  bot_name, delegation_title, requested_by_label, status, resolved_by,
  created_at, updated_at, status_changed_at
`

function mapRow(row: BotAccessRequestRow): BotAccessRequest {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    botId: row.bot_id,
    streamId: row.stream_id,
    delegationId: row.delegation_id,
    botName: row.bot_name,
    delegationTitle: row.delegation_title,
    requestedByLabel: row.requested_by_label,
    status: row.status as BotAccessRequestStatus,
    resolvedBy: row.resolved_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    statusChangedAt: row.status_changed_at,
  }
}

export const BotAccessRequestRepository = {
  /**
   * Insert an open request, or return the existing open one for the same
   * (workspace, bot, stream) — race-safe via the partial unique index (INV-20):
   * a bot polling the workspace nudge never spawns a duplicate card. `created`
   * tells the caller whether to append the `bot_access:requested` event (only a
   * genuinely new request gets a card).
   *
   * `DO UPDATE` (not `DO NOTHING`) so a row is ALWAYS returned: under READ
   * COMMITTED, `DO NOTHING` plus a same-statement fallback SELECT can return
   * zero rows for a genuine concurrent duplicate — the SELECT reads the
   * statement snapshot taken before the conflicting inserter committed, so it
   * doesn't see the row that made the insert a no-op. `DO UPDATE` re-reads the
   * conflicting row via EvalPlanQual and returns it. The `SET id = ...` is a
   * no-op touch whose only purpose is to force `RETURNING`. `(xmax = 0)`
   * distinguishes a fresh insert (xmax 0 → created) from a conflict update
   * (xmax = our xid → existing row). The partial-index predicate
   * (`status = 'open'`) must match the index literally to arbitrate on it.
   */
  async insertOrGetOpen(
    db: Querier,
    params: InsertBotAccessRequestParams
  ): Promise<{ request: BotAccessRequest; created: boolean }> {
    const result = await db.query<BotAccessRequestRow & { created: boolean }>(sql`
      INSERT INTO bot_access_requests (
        id, workspace_id, bot_id, stream_id, delegation_id,
        bot_name, delegation_title, requested_by_label, status
      ) VALUES (
        ${params.id}, ${params.workspaceId}, ${params.botId}, ${params.streamId}, ${params.delegationId},
        ${params.botName}, ${params.delegationTitle}, ${params.requestedByLabel}, ${BotAccessRequestStatuses.OPEN}
      )
      ON CONFLICT (workspace_id, bot_id, stream_id) WHERE status = 'open'
        DO UPDATE SET id = bot_access_requests.id
      RETURNING ${sql.raw(COLUMNS)}, (xmax = 0) AS created
    `)
    const row = result.rows[0]
    return { request: mapRow(row), created: row.created }
  },

  /** Read a single request by id, workspace-scoped (INV-8). */
  async findById(db: Querier, workspaceId: string, id: string): Promise<BotAccessRequest | null> {
    const result = await db.query<BotAccessRequestRow>(sql`
      SELECT ${sql.raw(COLUMNS)} FROM bot_access_requests
      WHERE id = ${id} AND workspace_id = ${workspaceId}
    `)
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },

  /**
   * CAS `open → approved`, recording the resolving user. Exactly one resolver
   * wins the status guard; a second approve/deny (or one racing the other) gets
   * `null`. Optionally stream-scoped so the first-party endpoint can bind the id
   * to the stream it was invoked from.
   */
  async approve(
    db: Querier,
    params: { workspaceId: string; id: string; streamId?: string; resolvedBy: string }
  ): Promise<BotAccessRequest | null> {
    const result = await db.query<BotAccessRequestRow>(sql`
      UPDATE bot_access_requests SET
        status = ${BotAccessRequestStatuses.APPROVED},
        resolved_by = ${params.resolvedBy},
        status_changed_at = NOW(),
        updated_at = NOW()
      WHERE id = ${params.id}
        AND workspace_id = ${params.workspaceId}
        AND (${params.streamId ?? null}::text IS NULL OR stream_id = ${params.streamId ?? null})
        AND status = ${BotAccessRequestStatuses.OPEN}
      RETURNING ${sql.raw(COLUMNS)}
    `)
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },

  /** CAS `open → denied`, recording the resolving user. `null` on a lost race. */
  async deny(
    db: Querier,
    params: { workspaceId: string; id: string; streamId?: string; resolvedBy: string }
  ): Promise<BotAccessRequest | null> {
    const result = await db.query<BotAccessRequestRow>(sql`
      UPDATE bot_access_requests SET
        status = ${BotAccessRequestStatuses.DENIED},
        resolved_by = ${params.resolvedBy},
        status_changed_at = NOW(),
        updated_at = NOW()
      WHERE id = ${params.id}
        AND workspace_id = ${params.workspaceId}
        AND (${params.streamId ?? null}::text IS NULL OR stream_id = ${params.streamId ?? null})
        AND status = ${BotAccessRequestStatuses.OPEN}
      RETURNING ${sql.raw(COLUMNS)}
    `)
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },
}
