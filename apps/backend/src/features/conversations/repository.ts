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
  message_ids: string[] | null
  participant_ids: string[] | null
  secondary_message_ids: string[] | null
}

/**
 * Internal backend type with native Date objects.
 * The wire type in @threa/types uses ISO 8601 strings for JSON serialization.
 *
 * `messageIds` and `participantIds` are populated from `conversation_message_assignments`
 * (primary assignments only, ordered by assigned_at). The arrays themselves are no
 * longer stored on the conversations row — they're aggregated at read time.
 *
 * `secondaryMessageIds` lists messages that are ALSO assigned to this conversation
 * but for which the primary lives elsewhere. Empty for conversations created before
 * multi-membership.
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
    messageIds: row.message_ids ?? [],
    participantIds: row.participant_ids ?? [],
    secondaryMessageIds: row.secondary_message_ids ?? [],
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

const BASE_FIELDS = `
  c.id, c.stream_id, c.workspace_id,
  c.topic_summary, c.completeness_score, c.confidence, c.status, c.parent_conversation_id,
  c.last_activity_at, c.created_at, c.updated_at
`

/**
 * Subquery that aggregates the message/participant arrays for one conversation.
 * Joined into the conversation SELECT via LEFT JOIN LATERAL so each conversation
 * row gets its derived arrays in a single round trip.
 *
 * `alias` is the outer-row alias to correlate against (`c` for the conversations
 * table, `u` for the UPDATE...RETURNING CTE in `update()`). Callers MUST pass a
 * literal identifier — never a value derived from user input — since it is
 * concatenated into the SQL string.
 *
 * - `message_ids`: primary-assignment message IDs, ordered by assigned_at.
 * - `participant_ids`: distinct authors of those primary-assigned messages.
 * - `secondary_message_ids`: message IDs assigned to this conversation but whose
 *   primary lives elsewhere.
 */
function assignmentAggregateJoin(alias: string): string {
  return `
    LEFT JOIN LATERAL (
      SELECT
        COALESCE(
          array_agg(cma.message_id ORDER BY cma.assigned_at) FILTER (WHERE cma.is_primary),
          ARRAY[]::TEXT[]
        ) AS message_ids,
        COALESCE(
          array_agg(DISTINCT m.author_id) FILTER (WHERE cma.is_primary AND m.author_id IS NOT NULL),
          ARRAY[]::TEXT[]
        ) AS participant_ids,
        COALESCE(
          array_agg(cma.message_id ORDER BY cma.assigned_at) FILTER (WHERE NOT cma.is_primary),
          ARRAY[]::TEXT[]
        ) AS secondary_message_ids
      FROM conversation_message_assignments cma
      LEFT JOIN messages m ON m.id = cma.message_id
      WHERE cma.conversation_id = ${alias}.id
    ) agg ON TRUE
  `
}

const ASSIGNMENT_AGGREGATE_JOIN = assignmentAggregateJoin("c")

const FULL_SELECT = `
  ${BASE_FIELDS},
  agg.message_ids, agg.participant_ids, agg.secondary_message_ids
`

export const ConversationRepository = {
  async findById(db: Querier, id: string): Promise<Conversation | null> {
    const result = await db.query<ConversationRow>(sql`
      SELECT ${sql.raw(FULL_SELECT)}
      FROM conversations c
      ${sql.raw(ASSIGNMENT_AGGREGATE_JOIN)}
      WHERE c.id = ${id}
    `)
    if (!result.rows[0]) return null
    return mapRowToConversation(result.rows[0])
  },

  /**
   * Batch lookup; returns conversations in arbitrary order.
   * Workspace-scoped (INV-8) — rows from other workspaces are filtered out at
   * the query level even if the caller passes IDs from the wrong workspace.
   */
  async findByIds(db: Querier, workspaceId: string, ids: string[]): Promise<Conversation[]> {
    if (ids.length === 0) return []
    const result = await db.query<ConversationRow>(sql`
      SELECT ${sql.raw(FULL_SELECT)}
      FROM conversations c
      ${sql.raw(ASSIGNMENT_AGGREGATE_JOIN)}
      WHERE c.workspace_id = ${workspaceId} AND c.id = ANY(${ids}::text[])
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
        SELECT ${sql.raw(FULL_SELECT)}
        FROM conversations c
        ${sql.raw(ASSIGNMENT_AGGREGATE_JOIN)}
        WHERE c.stream_id = ${streamId} AND c.status = ${options.status}
        ORDER BY c.last_activity_at DESC
        LIMIT ${limit}
      `)
      return result.rows.map(mapRowToConversation)
    }

    const result = await db.query<ConversationRow>(sql`
      SELECT ${sql.raw(FULL_SELECT)}
      FROM conversations c
      ${sql.raw(ASSIGNMENT_AGGREGATE_JOIN)}
      WHERE c.stream_id = ${streamId}
      ORDER BY c.last_activity_at DESC
      LIMIT ${limit}
    `)
    return result.rows.map(mapRowToConversation)
  },

  /**
   * Find conversations in a stream AND in any child threads of that stream.
   * Child threads are streams where parent_message_id belongs to a message in the given stream.
   */
  async findByStreamIncludingThreads(
    db: Querier,
    streamId: string,
    options?: { status?: ConversationStatus; limit?: number }
  ): Promise<Conversation[]> {
    const limit = options?.limit ?? 50

    if (options?.status) {
      const result = await db.query<ConversationRow>(sql`
        SELECT ${sql.raw(FULL_SELECT)}
        FROM conversations c
        ${sql.raw(ASSIGNMENT_AGGREGATE_JOIN)}
        WHERE (
          c.stream_id = ${streamId}
          OR c.stream_id IN (
            SELECT s.id FROM streams s
            WHERE s.type = 'thread'
              AND s.parent_message_id IN (
                SELECT m.id FROM messages m WHERE m.stream_id = ${streamId}
              )
          )
        )
        AND c.status = ${options.status}
        ORDER BY c.last_activity_at DESC
        LIMIT ${limit}
      `)
      return result.rows.map(mapRowToConversation)
    }

    const result = await db.query<ConversationRow>(sql`
      SELECT ${sql.raw(FULL_SELECT)}
      FROM conversations c
      ${sql.raw(ASSIGNMENT_AGGREGATE_JOIN)}
      WHERE c.stream_id = ${streamId}
         OR c.stream_id IN (
           SELECT s.id FROM streams s
           WHERE s.type = 'thread'
             AND s.parent_message_id IN (
               SELECT m.id FROM messages m WHERE m.stream_id = ${streamId}
             )
         )
      ORDER BY c.last_activity_at DESC
      LIMIT ${limit}
    `)
    return result.rows.map(mapRowToConversation)
  },

  async findActiveByStream(db: Querier, streamId: string, limit = 50): Promise<Conversation[]> {
    return this.findByStream(db, streamId, { status: "active", limit })
  },

  /**
   * Conversations that contain a specific message (primary or secondary).
   * Workspace-scoped (INV-8).
   */
  async findByMessageId(db: Querier, workspaceId: string, messageId: string): Promise<Conversation[]> {
    const result = await db.query<ConversationRow>(sql`
      SELECT ${sql.raw(FULL_SELECT)}
      FROM conversations c
      ${sql.raw(ASSIGNMENT_AGGREGATE_JOIN)}
      WHERE c.workspace_id = ${workspaceId}
        AND c.id IN (
          SELECT conversation_id FROM conversation_message_assignments
          WHERE message_id = ${messageId} AND workspace_id = ${workspaceId}
        )
      ORDER BY c.last_activity_at DESC
    `)
    return result.rows.map(mapRowToConversation)
  },

  /**
   * Find conversations that contain any of the given message IDs.
   * Returns unique conversations. Workspace-scoped (INV-8).
   */
  async findByMessageIds(db: Querier, workspaceId: string, messageIds: string[]): Promise<Conversation[]> {
    if (messageIds.length === 0) return []

    const result = await db.query<ConversationRow>(sql`
      SELECT ${sql.raw(FULL_SELECT)}
      FROM conversations c
      ${sql.raw(ASSIGNMENT_AGGREGATE_JOIN)}
      WHERE c.workspace_id = ${workspaceId}
        AND c.id IN (
          SELECT DISTINCT conversation_id FROM conversation_message_assignments
          WHERE message_id = ANY(${messageIds}::text[]) AND workspace_id = ${workspaceId}
        )
      ORDER BY c.last_activity_at DESC
    `)
    return result.rows.map(mapRowToConversation)
  },

  async findByWorkspace(
    db: Querier,
    workspaceId: string,
    options?: { status?: ConversationStatus; limit?: number }
  ): Promise<Conversation[]> {
    const limit = options?.limit ?? 50

    if (options?.status) {
      const result = await db.query<ConversationRow>(sql`
        SELECT ${sql.raw(FULL_SELECT)}
        FROM conversations c
        ${sql.raw(ASSIGNMENT_AGGREGATE_JOIN)}
        WHERE c.workspace_id = ${workspaceId} AND c.status = ${options.status}
        ORDER BY c.last_activity_at DESC
        LIMIT ${limit}
      `)
      return result.rows.map(mapRowToConversation)
    }

    const result = await db.query<ConversationRow>(sql`
      SELECT ${sql.raw(FULL_SELECT)}
      FROM conversations c
      ${sql.raw(ASSIGNMENT_AGGREGATE_JOIN)}
      WHERE c.workspace_id = ${workspaceId}
      ORDER BY c.last_activity_at DESC
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
      RETURNING
        id, stream_id, workspace_id,
        topic_summary, completeness_score, confidence, status, parent_conversation_id,
        last_activity_at, created_at, updated_at,
        ARRAY[]::TEXT[] AS message_ids,
        ARRAY[]::TEXT[] AS participant_ids,
        ARRAY[]::TEXT[] AS secondary_message_ids
    `)
    return mapRowToConversation(result.rows[0])
  },

  /**
   * Workspace-scoped update (INV-8). The UPDATE CTE filters by workspace_id so a
   * misrouted conversation ID from a different workspace silently no-ops rather
   * than writing into another tenant's data. The aggregate join is produced by
   * `assignmentAggregateJoin('u')` so it stays in sync with the read path.
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
        SELECT ${sql.raw(FULL_SELECT)}
        FROM conversations c
        ${sql.raw(ASSIGNMENT_AGGREGATE_JOIN)}
        WHERE c.workspace_id = ${workspaceId} AND c.id = ${id}
      `)
      if (!result.rows[0]) return null
      return mapRowToConversation(result.rows[0])
    }

    updates.push(`updated_at = NOW()`)
    const idParamIndex = paramIndex++
    const workspaceParamIndex = paramIndex
    values.push(id, workspaceId)

    // UPDATE + LATERAL aggregate in a single round-trip via CTE.
    const query = `
      WITH updated AS (
        UPDATE conversations
        SET ${updates.join(", ")}
        WHERE id = $${idParamIndex} AND workspace_id = $${workspaceParamIndex}
        RETURNING
          id, stream_id, workspace_id,
          topic_summary, completeness_score, confidence, status, parent_conversation_id,
          last_activity_at, created_at, updated_at
      )
      SELECT
        u.id, u.stream_id, u.workspace_id,
        u.topic_summary, u.completeness_score, u.confidence, u.status, u.parent_conversation_id,
        u.last_activity_at, u.created_at, u.updated_at,
        agg.message_ids, agg.participant_ids, agg.secondary_message_ids
      FROM updated u
      ${assignmentAggregateJoin("u")}
    `

    const result = await db.query<ConversationRow>(query, values)
    if (!result.rows[0]) return null
    return mapRowToConversation(result.rows[0])
  },

  /**
   * Bump last_activity_at on a conversation. Called when a new message is
   * assigned to it (the assignment row itself doesn't bump the conversation's
   * activity timestamp — that lives on the conversation row).
   */
  async bumpActivity(db: Querier, id: string): Promise<void> {
    await db.query(sql`
      UPDATE conversations
      SET last_activity_at = NOW(), updated_at = NOW()
      WHERE id = ${id}
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
