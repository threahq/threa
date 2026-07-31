import type { Querier } from "../../db"
import { sql } from "../../db"

export const MESSAGE_CONVERSATION_STATES = ["settling", "settled"] as const
export type MessageConversationState = (typeof MESSAGE_CONVERSATION_STATES)[number]

export const SETTLED_BY_REASONS = ["llm-window", "engagement", "user"] as const
export type SettledByReason = (typeof SETTLED_BY_REASONS)[number]

export interface SettlingRow {
  messageId: string
  workspaceId: string
  streamId: string
  conversationId: string
  state: MessageConversationState
  settledBy: SettledByReason | null
  settledAt: Date | null
}

interface SettlingDbRow {
  message_id: string
  workspace_id: string
  stream_id: string
  conversation_id: string
  state: string
  settled_by: string | null
  settled_at: Date | null
}

function mapRow(row: SettlingDbRow): SettlingRow {
  return {
    messageId: row.message_id,
    workspaceId: row.workspace_id,
    streamId: row.stream_id,
    conversationId: row.conversation_id,
    state: row.state as MessageConversationState,
    settledBy: row.settled_by as SettledByReason | null,
    settledAt: row.settled_at,
  }
}

/**
 * Provisional ("settling") conversation assignments. Absence of a row means the
 * assignment is settled/normal, so nothing needs backfilling and a settle is
 * always idempotent.
 */
export const MessageConversationStateRepository = {
  /**
   * Record a provisional assignment. An existing row wins (INV-20): a message
   * that already settled must not be dragged back to settling by a re-delivered
   * extraction pass.
   */
  async insertSettling(
    db: Querier,
    params: { messageId: string; workspaceId: string; streamId: string; conversationId: string }
  ): Promise<void> {
    await db.query(sql`
      INSERT INTO message_conversation_state (message_id, workspace_id, stream_id, conversation_id, state)
      VALUES (${params.messageId}, ${params.workspaceId}, ${params.streamId}, ${params.conversationId}, 'settling')
      ON CONFLICT (message_id) DO NOTHING
    `)
  },

  /** Settle every still-settling row among `messageIds`. Returns the rows it flipped. */
  async settle(
    db: Querier,
    workspaceId: string,
    messageIds: string[],
    settledBy: SettledByReason
  ): Promise<SettlingRow[]> {
    if (messageIds.length === 0) return []
    const result = await db.query<SettlingDbRow>(sql`
      UPDATE message_conversation_state
      SET state = 'settled', settled_by = ${settledBy}, settled_at = NOW(), updated_at = NOW()
      WHERE workspace_id = ${workspaceId}
        AND message_id = ANY(${messageIds}::text[])
        AND state = 'settling'
      RETURNING message_id, workspace_id, stream_id, conversation_id, state, settled_by, settled_at
    `)
    return result.rows.map(mapRow)
  },

  /**
   * Settle every still-settling row of `streamId` EXCEPT `keepMessageIds` — the
   * pass's context window. A row the extractor can no longer see will never be
   * revisited, so its placement is as good as it gets.
   *
   * `createdBefore` bounds the settle to rows that predate the pass's view: a
   * concurrent pass (BOUNDARY_EXTRACT has no fairness key) can insert a settling
   * row for a message this pass never saw, and settling it here would discard a
   * placement that is still provisional. It must come from the DB's own clock
   * (`SELECT NOW()` at pass start), never a JS `Date` (INV-66).
   */
  async settleStreamOutsideWindow(
    db: Querier,
    workspaceId: string,
    streamId: string,
    keepMessageIds: string[],
    settledBy: SettledByReason,
    createdBefore: Date
  ): Promise<SettlingRow[]> {
    const result = await db.query<SettlingDbRow>(sql`
      UPDATE message_conversation_state
      SET state = 'settled', settled_by = ${settledBy}, settled_at = NOW(), updated_at = NOW()
      WHERE workspace_id = ${workspaceId}
        AND stream_id = ${streamId}
        AND state = 'settling'
        AND created_at < ${createdBefore}
        AND NOT (message_id = ANY(${keepMessageIds}::text[]))
      RETURNING message_id, workspace_id, stream_id, conversation_id, state, settled_by, settled_at
    `)
    return result.rows.map(mapRow)
  },

  /** The DB's own clock, for bounding a pass's settle to rows that predate its view. */
  async now(db: Querier): Promise<Date> {
    const result = await db.query<{ now: Date }>(sql`SELECT NOW() AS now`)
    return result.rows[0]!.now
  },

  /**
   * Re-file AND settle in one statement: the user moved the message, so the row
   * must follow it rather than keep pointing at the conversation it left.
   */
  async settleForConversationTarget(
    db: Querier,
    workspaceId: string,
    messageId: string,
    conversationId: string,
    settledBy: SettledByReason
  ): Promise<SettlingRow | null> {
    const result = await db.query<SettlingDbRow>(sql`
      UPDATE message_conversation_state
      SET conversation_id = ${conversationId},
          state = 'settled',
          settled_by = ${settledBy},
          settled_at = NOW(),
          updated_at = NOW()
      WHERE workspace_id = ${workspaceId} AND message_id = ${messageId} AND state = 'settling'
      RETURNING message_id, workspace_id, stream_id, conversation_id, state, settled_by, settled_at
    `)
    const row = result.rows[0]
    return row ? mapRow(row) : null
  },

  /** Set-based counterpart of {@link settleForConversationTarget} (INV-56). */
  async settleForConversationTargets(
    db: Querier,
    workspaceId: string,
    messageIds: string[],
    conversationId: string,
    settledBy: SettledByReason
  ): Promise<SettlingRow[]> {
    if (messageIds.length === 0) return []
    const result = await db.query<SettlingDbRow>(sql`
      UPDATE message_conversation_state
      SET conversation_id = ${conversationId},
          state = 'settled',
          settled_by = ${settledBy},
          settled_at = NOW(),
          updated_at = NOW()
      WHERE workspace_id = ${workspaceId}
        AND message_id = ANY(${messageIds}::text[])
        AND state = 'settling'
      RETURNING message_id, workspace_id, stream_id, conversation_id, state, settled_by, settled_at
    `)
    return result.rows.map(mapRow)
  },

  /** Move still-settling rows to another conversation without settling them (LLM re-file). */
  async moveConversation(
    db: Querier,
    workspaceId: string,
    messageIds: string[],
    conversationId: string
  ): Promise<void> {
    if (messageIds.length === 0) return
    await db.query(sql`
      UPDATE message_conversation_state
      SET conversation_id = ${conversationId}, updated_at = NOW()
      WHERE workspace_id = ${workspaceId}
        AND message_id = ANY(${messageIds}::text[])
        AND state = 'settling'
    `)
  },

  /** The wire read: settling message ids grouped by conversation. One query (INV-30). */
  async listSettlingByConversationIds(
    db: Querier,
    workspaceId: string,
    conversationIds: string[]
  ): Promise<Map<string, string[]>> {
    const byConversation = new Map<string, string[]>()
    if (conversationIds.length === 0) return byConversation
    const result = await db.query<{ conversation_id: string; message_id: string }>(sql`
      SELECT conversation_id, message_id
      FROM message_conversation_state
      WHERE workspace_id = ${workspaceId}
        AND state = 'settling'
        AND conversation_id = ANY(${conversationIds}::text[])
      ORDER BY created_at ASC
    `)
    for (const row of result.rows) {
      const existing = byConversation.get(row.conversation_id)
      if (existing) existing.push(row.message_id)
      else byConversation.set(row.conversation_id, [row.message_id])
    }
    return byConversation
  },

  /** Sweep backstop: settle everything that has been settling longer than `olderThanSeconds`. */
  async settleOlderThan(db: Querier, olderThanSeconds: number, limit: number): Promise<SettlingRow[]> {
    const result = await db.query<SettlingDbRow>(sql`
      UPDATE message_conversation_state
      SET state = 'settled', settled_by = 'llm-window', settled_at = NOW(), updated_at = NOW()
      WHERE message_id IN (
        SELECT message_id FROM message_conversation_state
        WHERE state = 'settling'
          AND created_at < NOW() - (${olderThanSeconds}::int * INTERVAL '1 second')
        ORDER BY created_at ASC
        LIMIT ${limit}
      )
      RETURNING message_id, workspace_id, stream_id, conversation_id, state, settled_by, settled_at
    `)
    return result.rows.map(mapRow)
  },
}
