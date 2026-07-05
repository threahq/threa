import type { Querier } from "../../db"
import { sql } from "../../db"

/** A hidden conversation for the bootstrap read. */
export interface HiddenConversation {
  conversationId: string
  hiddenAt: Date
}

/**
 * Per-viewer board exclusions: hidden conversation cards and muted streams
 * (board-view-design.md § "Hide & mute"). Every write is a race-safe upsert/delete
 * (INV-20); reads are single-query, so callers pass `pool` (INV-30).
 */
export const BoardExclusionRepository = {
  /** Hide (or re-hide) a conversation for a viewer. Returns the snooze watermark. */
  async hideConversation(
    db: Querier,
    params: { workspaceId: string; conversationId: string; userId: string }
  ): Promise<{ hiddenAt: Date }> {
    const result = await db.query<{ hidden_at: Date }>(sql`
      INSERT INTO board_hidden_conversations (workspace_id, conversation_id, user_id)
      VALUES (${params.workspaceId}, ${params.conversationId}, ${params.userId})
      ON CONFLICT (conversation_id, user_id) DO UPDATE SET hidden_at = NOW()
      RETURNING hidden_at
    `)
    return { hiddenAt: result.rows[0]!.hidden_at }
  },

  async unhideConversation(db: Querier, workspaceId: string, conversationId: string, userId: string): Promise<void> {
    await db.query(sql`
      DELETE FROM board_hidden_conversations
      WHERE workspace_id = ${workspaceId} AND conversation_id = ${conversationId} AND user_id = ${userId}
    `)
  },

  async muteStream(db: Querier, params: { workspaceId: string; streamId: string; userId: string }): Promise<void> {
    await db.query(sql`
      INSERT INTO board_muted_streams (workspace_id, stream_id, user_id)
      VALUES (${params.workspaceId}, ${params.streamId}, ${params.userId})
      ON CONFLICT (stream_id, user_id) DO NOTHING
    `)
  },

  async unmuteStream(db: Querier, workspaceId: string, streamId: string, userId: string): Promise<void> {
    await db.query(sql`
      DELETE FROM board_muted_streams
      WHERE workspace_id = ${workspaceId} AND stream_id = ${streamId} AND user_id = ${userId}
    `)
  },

  async listHiddenConversations(db: Querier, workspaceId: string, userId: string): Promise<HiddenConversation[]> {
    const result = await db.query<{ conversation_id: string; hidden_at: Date }>(sql`
      SELECT conversation_id, hidden_at FROM board_hidden_conversations
      WHERE workspace_id = ${workspaceId} AND user_id = ${userId}
    `)
    return result.rows.map((row) => ({ conversationId: row.conversation_id, hiddenAt: row.hidden_at }))
  },

  async listMutedStreamIds(db: Querier, workspaceId: string, userId: string): Promise<string[]> {
    const result = await db.query<{ stream_id: string }>(sql`
      SELECT stream_id FROM board_muted_streams
      WHERE workspace_id = ${workspaceId} AND user_id = ${userId}
    `)
    return result.rows.map((row) => row.stream_id)
  },
}
