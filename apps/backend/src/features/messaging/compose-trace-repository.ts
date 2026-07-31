import type { Querier } from "../../db"
import { sql } from "../../db"

interface MessageComposeTraceRow {
  message_id: string
  workspace_id: string
  stream_id: string
  horizon_stream_id: string
  opened_at: Date
  opened_at_sequence: string | null
  sent_at_sequence: string | null
  resumed_draft: boolean
  created_at: Date
}

export interface MessageComposeTrace {
  messageId: string
  workspaceId: string
  streamId: string
  horizonStreamId: string
  openedAt: Date
  openedAtSequence: string | null
  sentAtSequence: string | null
  resumedDraft: boolean
  createdAt: Date
}

export interface InsertComposeTraceParams {
  messageId: string
  workspaceId: string
  /** Destination stream — where the message landed. */
  streamId: string
  /** Horizon stream — what the sequences were measured against. */
  horizonStreamId: string
  openedAt: string
  openedAtSequence: number | null
  sentAtSequence: number | null
  resumedDraft: boolean
}

function mapRow(row: MessageComposeTraceRow): MessageComposeTrace {
  return {
    messageId: row.message_id,
    workspaceId: row.workspace_id,
    streamId: row.stream_id,
    horizonStreamId: row.horizon_stream_id,
    openedAt: row.opened_at,
    openedAtSequence: row.opened_at_sequence,
    sentAtSequence: row.sent_at_sequence,
    resumedDraft: row.resumed_draft,
    createdAt: row.created_at,
  }
}

export const MessageComposeTraceRepository = {
  /**
   * Records one send's compose session. A retried send re-runs the whole create
   * transaction, so the conflict is expected and silent — the first trace is the
   * true one (INV-20).
   */
  async insert(db: Querier, params: InsertComposeTraceParams): Promise<void> {
    await db.query(sql`
      INSERT INTO message_compose_traces (
        message_id, workspace_id, stream_id, horizon_stream_id, opened_at, opened_at_sequence, sent_at_sequence,
        resumed_draft
      )
      VALUES (
        ${params.messageId},
        ${params.workspaceId},
        ${params.streamId},
        ${params.horizonStreamId},
        ${params.openedAt},
        ${params.openedAtSequence},
        ${params.sentAtSequence},
        ${params.resumedDraft}
      )
      ON CONFLICT (message_id) DO NOTHING
    `)
  },

  async findByMessageId(db: Querier, workspaceId: string, messageId: string): Promise<MessageComposeTrace | null> {
    const result = await db.query<MessageComposeTraceRow>(sql`
      SELECT * FROM message_compose_traces
      WHERE workspace_id = ${workspaceId} AND message_id = ${messageId}
    `)
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },
}
