import { sql, type Querier } from "../../db"
import type { ConversationStatus } from "@threa/types"

interface ConversationRow {
  id: string
  stream_id: string
  workspace_id: string
  topic_summary: string | null
  completeness_score: number
  confidence: number
  status: string
  parent_conversation_id: string | null
  last_activity_at: Date
  created_at: Date
  updated_at: Date
  message_ids: string[]
  participant_ids: string[]
  secondary_message_ids: string[]
}

/**
 * Internal backend type with native Date objects. The wire type in @threa/types
 * uses ISO 8601 strings for JSON serialization.
 *
 * `messageIds` lists the messages whose PRIMARY conversation is this one,
 * preserved in insertion order. `secondaryMessageIds` lists messages that also
 * appear in this conversation but whose primary lives elsewhere (cross-topic
 * references). `participantIds` are the distinct authors of `messageIds`.
 *
 * All three are stored as Postgres TEXT[] arrays on the conversation row; the
 * service is the sole writer and uses row-level locking on the message row to
 * keep concurrent calls from duplicating membership.
 */
export interface Conversation {
  id: string
  streamId: string
  workspaceId: string
  messageIds: string[]
  participantIds: string[]
  secondaryMessageIds: string[]
  topicSummary: string | null
  completenessScore: number
  confidence: number
  status: ConversationStatus
  parentConversationId: string | null
  lastActivityAt: Date
  createdAt: Date
  updatedAt: Date
}

export interface InsertConversationParams {
  id: string
  streamId: string
  workspaceId: string
  topicSummary?: string
  completenessScore?: number
  confidence?: number
  status?: ConversationStatus
  parentConversationId?: string
}

export interface UpdateConversationParams {
  topicSummary?: string
  completenessScore?: number
  confidence?: number
  status?: ConversationStatus
  lastActivityAt?: Date
}

function mapRowToConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    streamId: row.stream_id,
    workspaceId: row.workspace_id,
    messageIds: row.message_ids,
    participantIds: row.participant_ids,
    secondaryMessageIds: row.secondary_message_ids,
    topicSummary: row.topic_summary,
    completenessScore: row.completeness_score,
    confidence: row.confidence,
    status: row.status as ConversationStatus,
    parentConversationId: row.parent_conversation_id,
    lastActivityAt: row.last_activity_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

const SELECT_FIELDS = `
  id, stream_id, workspace_id,
  message_ids, participant_ids, secondary_message_ids,
  topic_summary, completeness_score, confidence, status, parent_conversation_id,
  last_activity_at, created_at, updated_at
`

export const ConversationRepository = {
  async findById(db: Querier, id: string): Promise<Conversation | null> {
    const result = await db.query<ConversationRow>(sql`
      SELECT ${sql.raw(SELECT_FIELDS)} FROM conversations WHERE id = ${id}
    `)
    if (!result.rows[0]) return null
    return mapRowToConversation(result.rows[0])
  },

  /**
   * Batch lookup; returns conversations in arbitrary order. Workspace-scoped
   * (INV-8) — rows from other workspaces are filtered out at the query level
   * even if the caller passes IDs from the wrong workspace.
   */
  async findByIds(db: Querier, workspaceId: string, ids: string[]): Promise<Conversation[]> {
    if (ids.length === 0) return []
    const result = await db.query<ConversationRow>(sql`
      SELECT ${sql.raw(SELECT_FIELDS)} FROM conversations
      WHERE workspace_id = ${workspaceId} AND id = ANY(${ids}::text[])
    `)
    return result.rows.map(mapRowToConversation)
  },

  async findByStream(
    db: Querier,
    streamId: string,
    options?: { status?: ConversationStatus; limit?: number }
  ): Promise<Conversation[]> {
    const limit = options?.limit ?? 50

    if (options?.status) {
      const result = await db.query<ConversationRow>(sql`
        SELECT ${sql.raw(SELECT_FIELDS)} FROM conversations
        WHERE stream_id = ${streamId} AND status = ${options.status}
        ORDER BY last_activity_at DESC
        LIMIT ${limit}
      `)
      return result.rows.map(mapRowToConversation)
    }

    const result = await db.query<ConversationRow>(sql`
      SELECT ${sql.raw(SELECT_FIELDS)} FROM conversations
      WHERE stream_id = ${streamId}
      ORDER BY last_activity_at DESC
      LIMIT ${limit}
    `)
    return result.rows.map(mapRowToConversation)
  },

  /**
   * Find conversations in a stream AND in any child threads of that stream.
   * Child threads are streams where parent_message_id belongs to a message in
   * the given stream.
   */
  async findByStreamIncludingThreads(
    db: Querier,
    streamId: string,
    options?: { status?: ConversationStatus; limit?: number }
  ): Promise<Conversation[]> {
    const limit = options?.limit ?? 50

    if (options?.status) {
      const result = await db.query<ConversationRow>(sql`
        SELECT ${sql.raw(SELECT_FIELDS)} FROM conversations
        WHERE (
          stream_id = ${streamId}
          OR stream_id IN (
            SELECT s.id FROM streams s
            WHERE s.type = 'thread'
              AND s.parent_message_id IN (
                SELECT m.id FROM messages m WHERE m.stream_id = ${streamId}
              )
          )
        )
        AND status = ${options.status}
        ORDER BY last_activity_at DESC
        LIMIT ${limit}
      `)
      return result.rows.map(mapRowToConversation)
    }

    const result = await db.query<ConversationRow>(sql`
      SELECT ${sql.raw(SELECT_FIELDS)} FROM conversations
      WHERE stream_id = ${streamId}
         OR stream_id IN (
           SELECT s.id FROM streams s
           WHERE s.type = 'thread'
             AND s.parent_message_id IN (
               SELECT m.id FROM messages m WHERE m.stream_id = ${streamId}
             )
         )
      ORDER BY last_activity_at DESC
      LIMIT ${limit}
    `)
    return result.rows.map(mapRowToConversation)
  },

  async findActiveByStream(db: Querier, streamId: string, limit = 50): Promise<Conversation[]> {
    return this.findByStream(db, streamId, { status: "active", limit })
  },

  /**
   * Conversations that contain a specific message (primary or secondary).
   * Workspace-scoped (INV-8). Uses the two GIN indexes on `message_ids` and
   * `secondary_message_ids`.
   */
  async findByMessageId(db: Querier, workspaceId: string, messageId: string): Promise<Conversation[]> {
    const result = await db.query<ConversationRow>(sql`
      SELECT ${sql.raw(SELECT_FIELDS)} FROM conversations
      WHERE workspace_id = ${workspaceId}
        AND (message_ids @> ARRAY[${messageId}]::text[] OR secondary_message_ids @> ARRAY[${messageId}]::text[])
      ORDER BY last_activity_at DESC
    `)
    return result.rows.map(mapRowToConversation)
  },

  /**
   * Find conversations that contain any of the given message IDs (primary or
   * secondary). Returns unique conversations. Workspace-scoped (INV-8).
   */
  async findByMessageIds(db: Querier, workspaceId: string, messageIds: string[]): Promise<Conversation[]> {
    if (messageIds.length === 0) return []
    const result = await db.query<ConversationRow>(sql`
      SELECT ${sql.raw(SELECT_FIELDS)} FROM conversations
      WHERE workspace_id = ${workspaceId}
        AND (message_ids && ${messageIds}::text[] OR secondary_message_ids && ${messageIds}::text[])
      ORDER BY last_activity_at DESC
    `)
    return result.rows.map(mapRowToConversation)
  },

  /**
   * Find the conversation that owns a message as PRIMARY (`message_ids`),
   * workspace-scoped. There can be at most one — enforced by the service, not
   * the database — so this returns a single row or null.
   */
  async findPrimaryByMessageId(db: Querier, workspaceId: string, messageId: string): Promise<Conversation | null> {
    const result = await db.query<ConversationRow>(sql`
      SELECT ${sql.raw(SELECT_FIELDS)} FROM conversations
      WHERE workspace_id = ${workspaceId}
        AND message_ids @> ARRAY[${messageId}]::text[]
      LIMIT 1
    `)
    if (!result.rows[0]) return null
    return mapRowToConversation(result.rows[0])
  },

  /**
   * Batch variant: returns a Map keyed by message_id of the conversation that
   * owns that message as primary. Missing keys → no primary. Workspace-scoped.
   *
   * The LATERAL unnest pairs each (message_id, conversation) row DB-side so
   * the Map is built in a single pass — no JS re-scan of message_ids arrays.
   */
  async findPrimariesByMessageIds(
    db: Querier,
    workspaceId: string,
    messageIds: string[]
  ): Promise<Map<string, Conversation>> {
    if (messageIds.length === 0) return new Map()
    const result = await db.query<ConversationRow & { matched_message_id: string }>(sql`
      SELECT ${sql.raw(SELECT_FIELDS)}, m.message_id AS matched_message_id
      FROM conversations c
      CROSS JOIN LATERAL unnest(c.message_ids) AS m(message_id)
      WHERE c.workspace_id = ${workspaceId}
        AND m.message_id = ANY(${messageIds}::text[])
    `)
    const byMessageId = new Map<string, Conversation>()
    for (const row of result.rows) {
      byMessageId.set(row.matched_message_id, mapRowToConversation(row))
    }
    return byMessageId
  },

  async findByWorkspace(
    db: Querier,
    workspaceId: string,
    options?: { status?: ConversationStatus; limit?: number }
  ): Promise<Conversation[]> {
    const limit = options?.limit ?? 50

    if (options?.status) {
      const result = await db.query<ConversationRow>(sql`
        SELECT ${sql.raw(SELECT_FIELDS)} FROM conversations
        WHERE workspace_id = ${workspaceId} AND status = ${options.status}
        ORDER BY last_activity_at DESC
        LIMIT ${limit}
      `)
      return result.rows.map(mapRowToConversation)
    }

    const result = await db.query<ConversationRow>(sql`
      SELECT ${sql.raw(SELECT_FIELDS)} FROM conversations
      WHERE workspace_id = ${workspaceId}
      ORDER BY last_activity_at DESC
      LIMIT ${limit}
    `)
    return result.rows.map(mapRowToConversation)
  },

  async insert(db: Querier, params: InsertConversationParams): Promise<Conversation> {
    const result = await db.query<ConversationRow>(sql`
      INSERT INTO conversations (
        id, stream_id, workspace_id,
        topic_summary, completeness_score, confidence, status, parent_conversation_id
      )
      VALUES (
        ${params.id},
        ${params.streamId},
        ${params.workspaceId},
        ${params.topicSummary ?? null},
        ${params.completenessScore ?? 1},
        ${params.confidence ?? 0.5},
        ${params.status ?? "active"},
        ${params.parentConversationId ?? null}
      )
      RETURNING ${sql.raw(SELECT_FIELDS)}
    `)
    return mapRowToConversation(result.rows[0])
  },

  /**
   * Workspace-scoped update (INV-8). The UPDATE filters by workspace_id so a
   * misrouted conversation ID from a different workspace silently no-ops rather
   * than writing into another tenant's data.
   */
  async update(
    db: Querier,
    workspaceId: string,
    id: string,
    params: UpdateConversationParams
  ): Promise<Conversation | null> {
    const updates: string[] = []
    const values: unknown[] = []
    let paramIndex = 1

    if (params.topicSummary !== undefined) {
      updates.push(`topic_summary = $${paramIndex++}`)
      values.push(params.topicSummary)
    }
    if (params.completenessScore !== undefined) {
      updates.push(`completeness_score = $${paramIndex++}`)
      values.push(params.completenessScore)
    }
    if (params.confidence !== undefined) {
      updates.push(`confidence = $${paramIndex++}`)
      values.push(params.confidence)
    }
    if (params.status !== undefined) {
      updates.push(`status = $${paramIndex++}`)
      values.push(params.status)
    }
    if (params.lastActivityAt !== undefined) {
      updates.push(`last_activity_at = $${paramIndex++}`)
      values.push(params.lastActivityAt)
    }

    if (updates.length === 0) {
      // No-op update still goes through the workspace-scoped read so a
      // cross-workspace lookup returns null instead of leaking the row.
      const result = await db.query<ConversationRow>(sql`
        SELECT ${sql.raw(SELECT_FIELDS)} FROM conversations
        WHERE workspace_id = ${workspaceId} AND id = ${id}
      `)
      if (!result.rows[0]) return null
      return mapRowToConversation(result.rows[0])
    }

    updates.push(`updated_at = NOW()`)
    values.push(id, workspaceId)
    const idParamIndex = paramIndex++
    const workspaceParamIndex = paramIndex

    const query = `
      UPDATE conversations
      SET ${updates.join(", ")}
      WHERE id = $${idParamIndex} AND workspace_id = $${workspaceParamIndex}
      RETURNING ${SELECT_FIELDS}
    `

    const result = await db.query<ConversationRow>(query, values)
    if (!result.rows[0]) return null
    return mapRowToConversation(result.rows[0])
  },

  /**
   * Append a message to `message_ids` (primary membership) and also add the
   * author to `participant_ids` if not already present. Idempotent: appending
   * a message_id that's already present is a no-op.
   *
   * Also clears the message from `secondary_message_ids` if it was there —
   * a message can be either primary or secondary in a given conversation, not
   * both.
   *
   * Workspace-scoped (INV-8). Caller is responsible for ensuring any prior
   * primary membership in another conversation has been removed first
   * (`removePrimaryMessage`), otherwise the message will appear in two
   * `message_ids` arrays and the "exactly one primary" invariant breaks.
   */
  async addPrimaryMessage(
    db: Querier,
    workspaceId: string,
    conversationId: string,
    messageId: string,
    authorId: string | null
  ): Promise<void> {
    await db.query(sql`
      UPDATE conversations
      SET message_ids =
            CASE WHEN message_ids @> ARRAY[${messageId}]::text[]
                 THEN message_ids
                 ELSE array_append(message_ids, ${messageId}) END,
          participant_ids =
            CASE WHEN ${authorId}::text IS NULL OR participant_ids @> ARRAY[${authorId}]::text[]
                 THEN participant_ids
                 ELSE array_append(participant_ids, ${authorId}) END,
          secondary_message_ids = array_remove(secondary_message_ids, ${messageId}),
          updated_at = NOW()
      WHERE id = ${conversationId} AND workspace_id = ${workspaceId}
    `)
  },

  /**
   * Append a message to `secondary_message_ids` (cross-topic reference). The
   * message's primary lives in another conversation. Idempotent and a no-op if
   * the message is already in this conversation's `message_ids` (would be a
   * downgrade — service must not request it).
   */
  async addSecondaryMessage(
    db: Querier,
    workspaceId: string,
    conversationId: string,
    messageId: string
  ): Promise<void> {
    await db.query(sql`
      UPDATE conversations
      SET secondary_message_ids =
            CASE WHEN message_ids @> ARRAY[${messageId}]::text[]
                  OR secondary_message_ids @> ARRAY[${messageId}]::text[]
                 THEN secondary_message_ids
                 ELSE array_append(secondary_message_ids, ${messageId}) END,
          updated_at = NOW()
      WHERE id = ${conversationId} AND workspace_id = ${workspaceId}
    `)
  },

  /**
   * Remove a message from a conversation's `message_ids` (primary membership).
   * Used by reassignment to clear the old home before adding to the new one.
   * Note: `participant_ids` is NOT recomputed — author may still have other
   * messages in this conversation. Recompute via `recomputeParticipants` if
   * the caller wants strict bookkeeping.
   */
  async removePrimaryMessage(
    db: Querier,
    workspaceId: string,
    conversationId: string,
    messageId: string
  ): Promise<void> {
    await db.query(sql`
      UPDATE conversations
      SET message_ids = array_remove(message_ids, ${messageId}),
          updated_at = NOW()
      WHERE id = ${conversationId} AND workspace_id = ${workspaceId}
    `)
  },

  /** Bump last_activity_at on many conversations in one round-trip. Workspace-scoped (INV-8). */
  async bumpActivityForIds(db: Querier, workspaceId: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return
    await db.query(sql`
      UPDATE conversations
      SET last_activity_at = NOW(), updated_at = NOW()
      WHERE workspace_id = ${workspaceId} AND id = ANY(${ids}::text[])
    `)
  },

  async delete(db: Querier, id: string): Promise<boolean> {
    const result = await db.query(sql`DELETE FROM conversations WHERE id = ${id}`)
    return result.rowCount !== null && result.rowCount > 0
  },
}
