import type { Querier } from "../../db"
import { sql } from "../../db"
import {
  DecisionRequestStatuses,
  type DecisionOption,
  type DecisionRequest,
  type DecisionRequestKind,
  type DecisionRequestStatus,
  type DecisionResolution,
} from "@threahq/types"

interface DecisionRequestRow {
  id: string
  workspace_id: string
  stream_id: string
  requester_bot_id: string | null
  requester_runtime_session_id: string | null
  requester_invocation_id: string | null
  kind: string
  title: string
  body_markdown: string | null
  options: DecisionOption[]
  allow_note: boolean
  external_ref: string | null
  status: string
  resolution: DecisionResolution | null
  expires_at: Date | null
  version: number
  created_at: Date
  updated_at: Date
}

/** In-process shape: dates stay `Date` here and serialize at the boundary. */
export interface DecisionRequestRecord {
  id: string
  workspaceId: string
  streamId: string
  requesterBotId: string | null
  requesterRuntimeSessionId: string | null
  requesterInvocationId: string | null
  kind: DecisionRequestKind
  title: string
  bodyMarkdown: string | null
  options: DecisionOption[]
  allowNote: boolean
  externalRef: string | null
  status: DecisionRequestStatus
  resolution: DecisionResolution | null
  expiresAt: Date | null
  version: number
  createdAt: Date
  updatedAt: Date
}

export interface InsertDecisionRequestParams {
  id: string
  workspaceId: string
  streamId: string
  requesterBotId: string | null
  requesterRuntimeSessionId: string | null
  requesterInvocationId: string | null
  kind: DecisionRequestKind
  title: string
  bodyMarkdown: string | null
  options: DecisionOption[]
  allowNote: boolean
  externalRef: string | null
  expiresAt: Date | null
}

const COLUMNS = `
  id, workspace_id, stream_id, requester_bot_id, requester_runtime_session_id, requester_invocation_id,
  kind, title, body_markdown, options, allow_note, external_ref, status, resolution,
  expires_at, version, created_at, updated_at
`

function mapRow(row: DecisionRequestRow): DecisionRequestRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    streamId: row.stream_id,
    requesterBotId: row.requester_bot_id,
    requesterRuntimeSessionId: row.requester_runtime_session_id,
    requesterInvocationId: row.requester_invocation_id,
    kind: row.kind as DecisionRequestKind,
    title: row.title,
    bodyMarkdown: row.body_markdown,
    options: row.options,
    allowNote: row.allow_note,
    externalRef: row.external_ref,
    status: row.status as DecisionRequestStatus,
    resolution: row.resolution,
    expiresAt: row.expires_at,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** Wire shape (`@threahq/types`): ISO dates, absent rather than null. */
export function serializeDecisionRequest(record: DecisionRequestRecord): DecisionRequest {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    streamId: record.streamId,
    requesterBotId: record.requesterBotId ?? undefined,
    requesterRuntimeSessionId: record.requesterRuntimeSessionId ?? undefined,
    requesterInvocationId: record.requesterInvocationId ?? undefined,
    kind: record.kind,
    title: record.title,
    bodyMarkdown: record.bodyMarkdown ?? undefined,
    options: record.options,
    allowNote: record.allowNote,
    externalRef: record.externalRef ?? undefined,
    status: record.status,
    resolution: record.resolution ?? undefined,
    expiresAt: record.expiresAt?.toISOString(),
    version: record.version,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  }
}

export const DecisionRequestRepository = {
  async insert(db: Querier, params: InsertDecisionRequestParams): Promise<DecisionRequestRecord> {
    const result = await db.query<DecisionRequestRow>(sql`
      INSERT INTO decision_requests (
        id, workspace_id, stream_id, requester_bot_id, requester_runtime_session_id, requester_invocation_id,
        kind, title, body_markdown, options, allow_note, external_ref, status, expires_at
      ) VALUES (
        ${params.id}, ${params.workspaceId}, ${params.streamId}, ${params.requesterBotId},
        ${params.requesterRuntimeSessionId}, ${params.requesterInvocationId},
        ${params.kind}, ${params.title}, ${params.bodyMarkdown}, ${JSON.stringify(params.options)},
        ${params.allowNote}, ${params.externalRef}, ${DecisionRequestStatuses.OPEN}, ${params.expiresAt}
      )
      RETURNING ${sql.raw(COLUMNS)}
    `)
    return mapRow(result.rows[0])
  },

  /** Read one decision, workspace-scoped (INV-8). */
  async findById(db: Querier, workspaceId: string, id: string): Promise<DecisionRequestRecord | null> {
    const result = await db.query<DecisionRequestRow>(sql`
      SELECT ${sql.raw(COLUMNS)} FROM decision_requests
      WHERE id = ${id} AND workspace_id = ${workspaceId}
    `)
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },

  /**
   * CAS `open → resolved` on the version the resolver saw (INV-66). Two people
   * answering the same card race here: the loser gets `null` and reads back the
   * answer that landed.
   */
  async resolve(
    db: Querier,
    params: { workspaceId: string; id: string; expectedVersion: number; resolution: DecisionResolution }
  ): Promise<DecisionRequestRecord | null> {
    const result = await db.query<DecisionRequestRow>(sql`
      UPDATE decision_requests SET
        status = ${DecisionRequestStatuses.RESOLVED},
        resolution = ${JSON.stringify(params.resolution)},
        version = version + 1,
        updated_at = NOW()
      WHERE id = ${params.id}
        AND workspace_id = ${params.workspaceId}
        AND status = ${DecisionRequestStatuses.OPEN}
        AND version = ${params.expectedVersion}
      RETURNING ${sql.raw(COLUMNS)}
    `)
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },

  /**
   * CAS `open → cancelled`. `expectedVersion` is optional: the requesting bot
   * withdrawing its own question has no version in hand, and `status = 'open'`
   * already makes the write single-shot.
   */
  async cancel(
    db: Querier,
    params: { workspaceId: string; id: string; expectedVersion?: number }
  ): Promise<DecisionRequestRecord | null> {
    const expected = params.expectedVersion ?? null
    const result = await db.query<DecisionRequestRow>(sql`
      UPDATE decision_requests SET
        status = ${DecisionRequestStatuses.CANCELLED},
        version = version + 1,
        updated_at = NOW()
      WHERE id = ${params.id}
        AND workspace_id = ${params.workspaceId}
        AND status = ${DecisionRequestStatuses.OPEN}
        AND (${expected}::int IS NULL OR version = ${expected})
      RETURNING ${sql.raw(COLUMNS)}
    `)
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },

  /** Set-based expiry of every lapsed open decision (INV-56), returning what moved. */
  async expireDue(db: Querier, now: Date): Promise<DecisionRequestRecord[]> {
    const result = await db.query<DecisionRequestRow>(sql`
      UPDATE decision_requests SET
        status = ${DecisionRequestStatuses.EXPIRED},
        version = version + 1,
        updated_at = NOW()
      WHERE status = ${DecisionRequestStatuses.OPEN}
        AND expires_at IS NOT NULL
        AND expires_at <= ${now}
      RETURNING ${sql.raw(COLUMNS)}
    `)
    return result.rows.map(mapRow)
  },
}
