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

  /** The message's state row, or null when its assignment was never provisional. */
  async findByMessageId(db: Querier, workspaceId: string, messageId: string): Promise<SettlingRow | null> {
    const result = await db.query<SettlingDbRow>(sql`
      SELECT message_id, workspace_id, stream_id, conversation_id, state, settled_by, settled_at
      FROM message_conversation_state
      WHERE workspace_id = ${workspaceId} AND message_id = ${messageId}
    `)
    const row = result.rows[0]
    return row ? mapRow(row) : null
  },

  /** State rows for `messageIds`, keyed by message id. Absent = never provisional. */
  async findByMessageIds(db: Querier, workspaceId: string, messageIds: string[]): Promise<Map<string, SettlingRow>> {
    if (messageIds.length === 0) return new Map()
    const result = await db.query<SettlingDbRow>(sql`
      SELECT message_id, workspace_id, stream_id, conversation_id, state, settled_by, settled_at
      FROM message_conversation_state
      WHERE workspace_id = ${workspaceId} AND message_id = ANY(${messageIds}::text[])
    `)
    return new Map(result.rows.map((row) => [row.message_id, mapRow(row)]))
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
    // Strictly backwards-looking on BOTH axes. `created_at < createdBefore`
    // (DB clock) protects rows a concurrent pass wrote after this one began;
    // the sequence subquery protects rows for messages NEWER than this pass's
    // window — a late pass (its LLM round-trip outlived several later sends)
    // must not settle placements those messages' own passes still consider
    // provisional. Passes only ever settle behind the window, never ahead.
    const result = await db.query<SettlingDbRow>(sql`
      UPDATE message_conversation_state mcs
      SET state = 'settled', settled_by = ${settledBy}, settled_at = NOW(), updated_at = NOW()
      FROM messages m
      WHERE mcs.workspace_id = ${workspaceId}
        AND mcs.stream_id = ${streamId}
        AND mcs.state = 'settling'
        AND mcs.created_at < ${createdBefore}
        AND NOT (mcs.message_id = ANY(${keepMessageIds}::text[]))
        AND m.id = mcs.message_id
        AND m.sequence < (SELECT MIN(mw.sequence) FROM messages mw WHERE mw.id = ANY(${keepMessageIds}::text[]) AND mw.stream_id = ${streamId})
      RETURNING mcs.message_id, mcs.workspace_id, mcs.stream_id, mcs.conversation_id, mcs.state, mcs.settled_by, mcs.settled_at
    `)
    return result.rows.map(mapRow)
  },

  /** The DB's own clock, for bounding a pass's settle to rows that predate its view. */
  async now(db: Querier): Promise<Date> {
    const result = await db.query<{ now: Date }>(sql`SELECT NOW() AS now`)
    return result.rows[0]!.now
  },

  /**
   * Re-file AND settle: the row must follow the message rather than keep
   * pointing at the conversation it left.
   *
   * A human placement (`'user'`) UPSERTS — the extractor skips a `'user'` row
   * forever, so the mark has to exist even when the message was never
   * provisional, and has to carry the CURRENT conversation even when the row
   * was already settled. Machine settles stay update-only against a still
   * settling row: absence of a row means "not provisional", and a settle must
   * not manufacture one.
   */
  async settleForConversationTarget(
    db: Querier,
    workspaceId: string,
    messageId: string,
    conversationId: string,
    settledBy: SettledByReason
  ): Promise<SettlingRow | null> {
    const rows = await this.settleForConversationTargets(db, workspaceId, [messageId], conversationId, settledBy)
    return rows[0] ?? null
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
    if (settledBy === "user") {
      // `stream_id` comes from the message itself — `messages` carries no
      // workspace_id, so the workspace scope (INV-8) rides the literal below.
      const upserted = await db.query<SettlingDbRow>(sql`
        INSERT INTO message_conversation_state (message_id, workspace_id, stream_id, conversation_id, state, settled_by, settled_at)
        SELECT m.id, ${workspaceId}, m.stream_id, ${conversationId}, 'settled', 'user', NOW()
        FROM messages m
        WHERE m.id = ANY(${messageIds}::text[])
        ON CONFLICT (message_id) DO UPDATE
        SET conversation_id = EXCLUDED.conversation_id,
            state = 'settled',
            settled_by = 'user',
            settled_at = NOW(),
            updated_at = NOW()
        WHERE message_conversation_state.workspace_id = ${workspaceId}
        RETURNING message_id, workspace_id, stream_id, conversation_id, state, settled_by, settled_at
      `)
      return upserted.rows.map(mapRow)
    }
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
