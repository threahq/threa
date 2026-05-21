import { sql, type Querier } from "../../db"
import { conversationMessageAssignmentId } from "../../lib/id"

export type AssignmentReason = "initial" | "reassigned" | "secondary" | "merge" | "backfill" | "manual"

interface AssignmentRow {
  id: string
  workspace_id: string
  conversation_id: string
  message_id: string
  stream_id: string
  is_primary: boolean
  assigned_at: Date
  reason: string
  confidence: number | null
  created_at: Date
}

export interface ConversationMessageAssignment {
  id: string
  workspaceId: string
  conversationId: string
  messageId: string
  streamId: string
  isPrimary: boolean
  assignedAt: Date
  reason: AssignmentReason
  confidence: number | null
  createdAt: Date
}

export interface AssignParams {
  conversationId: string
  messageId: string
  streamId: string
  workspaceId: string
  reason: AssignmentReason
  confidence?: number | null
}

function mapRow(row: AssignmentRow): ConversationMessageAssignment {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    conversationId: row.conversation_id,
    messageId: row.message_id,
    streamId: row.stream_id,
    isPrimary: row.is_primary,
    assignedAt: row.assigned_at,
    reason: row.reason as AssignmentReason,
    confidence: row.confidence,
    createdAt: row.created_at,
  }
}

const SELECT_FIELDS = `
  id, workspace_id, conversation_id, message_id, stream_id,
  is_primary, assigned_at, reason, confidence, created_at
`

export const ConversationMessageAssignmentRepository = {
  /**
   * Set the primary conversation for a message.
   *
   * If a primary already exists for this message in another conversation, it is
   * moved (the row is updated in place via ON CONFLICT on the partial unique
   * index). If a secondary assignment for the same (conv, message) already
   * exists, it is dropped first so the new primary doesn't collide on the
   * (conv, message) unique index.
   *
   * Race safety (INV-20): the partial unique index `(message_id) WHERE is_primary`
   * guarantees at most one primary per message. Concurrent callers either both
   * see consistent state via the ON CONFLICT path, or one fails with a unique
   * violation that the worker can retry.
   */
  async assignPrimary(db: Querier, params: AssignParams): Promise<ConversationMessageAssignment> {
    await db.query(sql`
      DELETE FROM conversation_message_assignments
      WHERE message_id = ${params.messageId}
        AND conversation_id = ${params.conversationId}
        AND NOT is_primary
    `)

    const result = await db.query<AssignmentRow>(sql`
      INSERT INTO conversation_message_assignments (
        id, workspace_id, conversation_id, message_id, stream_id,
        is_primary, reason, confidence
      )
      VALUES (
        ${conversationMessageAssignmentId()},
        ${params.workspaceId},
        ${params.conversationId},
        ${params.messageId},
        ${params.streamId},
        TRUE,
        ${params.reason},
        ${params.confidence ?? null}
      )
      ON CONFLICT (message_id) WHERE is_primary
      DO UPDATE SET
        conversation_id = EXCLUDED.conversation_id,
        stream_id = EXCLUDED.stream_id,
        reason = EXCLUDED.reason,
        confidence = EXCLUDED.confidence,
        assigned_at = NOW()
      RETURNING ${sql.raw(SELECT_FIELDS)}
    `)
    return mapRow(result.rows[0])
  },

  /**
   * Add a secondary assignment for a message in a conversation. No-op if the
   * message is already assigned (primary or secondary) to that conversation.
   */
  async assignSecondary(db: Querier, params: AssignParams): Promise<ConversationMessageAssignment | null> {
    const result = await db.query<AssignmentRow>(sql`
      INSERT INTO conversation_message_assignments (
        id, workspace_id, conversation_id, message_id, stream_id,
        is_primary, reason, confidence
      )
      VALUES (
        ${conversationMessageAssignmentId()},
        ${params.workspaceId},
        ${params.conversationId},
        ${params.messageId},
        ${params.streamId},
        FALSE,
        ${params.reason},
        ${params.confidence ?? null}
      )
      ON CONFLICT (conversation_id, message_id) DO NOTHING
      RETURNING ${sql.raw(SELECT_FIELDS)}
    `)
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },

  /** All assignments for a message (primary + secondaries). */
  async findByMessageId(db: Querier, messageId: string): Promise<ConversationMessageAssignment[]> {
    const result = await db.query<AssignmentRow>(sql`
      SELECT ${sql.raw(SELECT_FIELDS)} FROM conversation_message_assignments
      WHERE message_id = ${messageId}
      ORDER BY is_primary DESC, assigned_at ASC
    `)
    return result.rows.map(mapRow)
  },

  /** All assignments for any of the given messages. */
  async findByMessageIds(db: Querier, messageIds: string[]): Promise<ConversationMessageAssignment[]> {
    if (messageIds.length === 0) return []
    const result = await db.query<AssignmentRow>(sql`
      SELECT ${sql.raw(SELECT_FIELDS)} FROM conversation_message_assignments
      WHERE message_id = ANY(${messageIds}::text[])
      ORDER BY is_primary DESC, assigned_at ASC
    `)
    return result.rows.map(mapRow)
  },

  /** Primary assignment for a message, if one exists. */
  async findPrimaryByMessageId(db: Querier, messageId: string): Promise<ConversationMessageAssignment | null> {
    const result = await db.query<AssignmentRow>(sql`
      SELECT ${sql.raw(SELECT_FIELDS)} FROM conversation_message_assignments
      WHERE message_id = ${messageId} AND is_primary
      LIMIT 1
    `)
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },

  /** All assignments belonging to a conversation, ordered by assigned_at. */
  async findByConversationId(db: Querier, conversationId: string): Promise<ConversationMessageAssignment[]> {
    const result = await db.query<AssignmentRow>(sql`
      SELECT ${sql.raw(SELECT_FIELDS)} FROM conversation_message_assignments
      WHERE conversation_id = ${conversationId}
      ORDER BY assigned_at ASC
    `)
    return result.rows.map(mapRow)
  },
}
