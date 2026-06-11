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
}
