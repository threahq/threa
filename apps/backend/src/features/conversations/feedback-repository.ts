import { sql, type Querier } from "../../db"

export interface InsertConversationFeedbackParams {
  id: string
  workspaceId: string
  streamId: string
  messageId: string
  /** Null when the message had no primary conversation at correction time. */
  fromConversationId: string | null
  toConversationId: string
  userId: string
}

/**
 * Durable record of user corrections to conversation membership. Write-only
 * from the product surface; read offline (scripts/analyze-conversation-
 * boundaries.ts and future extractor evals) as ground truth for where the
 * boundary extractor drew the wrong line.
 */
export const ConversationFeedbackRepository = {
  async insert(db: Querier, params: InsertConversationFeedbackParams): Promise<void> {
    await db.query(sql`
      INSERT INTO conversation_feedback (
        id, workspace_id, stream_id, message_id,
        from_conversation_id, to_conversation_id, user_id
      )
      VALUES (
        ${params.id},
        ${params.workspaceId},
        ${params.streamId},
        ${params.messageId},
        ${params.fromConversationId},
        ${params.toConversationId},
        ${params.userId}
      )
    `)
  },

  /**
   * Batch variant (INV-56): one multi-row insert for a correction that moves
   * several messages at once (the thread-split flow records a feedback row per
   * moved message). `from_conversation_id` may be null per row.
   */
  async insertMany(db: Querier, rows: InsertConversationFeedbackParams[]): Promise<void> {
    if (rows.length === 0) return
    await db.query(sql`
      INSERT INTO conversation_feedback (
        id, workspace_id, stream_id, message_id,
        from_conversation_id, to_conversation_id, user_id
      )
      SELECT id, workspace_id, stream_id, message_id, from_conversation_id, to_conversation_id, user_id
      FROM unnest(
        ${rows.map((r) => r.id)}::text[],
        ${rows.map((r) => r.workspaceId)}::text[],
        ${rows.map((r) => r.streamId)}::text[],
        ${rows.map((r) => r.messageId)}::text[],
        ${rows.map((r) => r.fromConversationId)}::text[],
        ${rows.map((r) => r.toConversationId)}::text[],
        ${rows.map((r) => r.userId)}::text[]
      ) AS t(id, workspace_id, stream_id, message_id, from_conversation_id, to_conversation_id, user_id)
    `)
  },
}
