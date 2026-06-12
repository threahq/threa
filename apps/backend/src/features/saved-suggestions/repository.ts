import type { Querier } from "../../db"
import { sql } from "../../db"
import { savedSuggestionId } from "../../lib/id"
import { SavedSuggestionStatuses, type SavedSuggestionStatus } from "@threa/types"

interface SavedSuggestionRow {
  id: string
  workspace_id: string
  user_id: string
  stream_id: string
  conversation_id: string
  title: string
  context: string | null
  source_message_ids: string[]
  due_at: Date | null
  confidence: number | null
  status: string
  saved_message_id: string | null
  created_at: Date
  status_changed_at: Date
  updated_at: Date
}

export interface SavedSuggestion {
  id: string
  workspaceId: string
  userId: string
  streamId: string
  conversationId: string
  title: string
  context: string | null
  sourceMessageIds: string[]
  dueAt: Date | null
  confidence: number | null
  status: SavedSuggestionStatus
  savedMessageId: string | null
  createdAt: Date
  statusChangedAt: Date
  updatedAt: Date
}

export interface InsertSuggestionParams {
  workspaceId: string
  userId: string
  streamId: string
  conversationId: string
  title: string
  context: string | null
  sourceMessageIds: string[]
  dueAt: Date | null
  confidence: number | null
}

export interface ListSuggestionsOpts {
  status: SavedSuggestionStatus
  limit?: number
  cursor?: string
}

const COLUMNS =
  "id, workspace_id, user_id, stream_id, conversation_id, title, context, source_message_ids, due_at, confidence, status, saved_message_id, created_at, status_changed_at, updated_at"

function mapRow(row: SavedSuggestionRow): SavedSuggestion {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    userId: row.user_id,
    streamId: row.stream_id,
    conversationId: row.conversation_id,
    title: row.title,
    context: row.context,
    sourceMessageIds: row.source_message_ids,
    dueAt: row.due_at,
    confidence: row.confidence,
    status: row.status as SavedSuggestionStatus,
    savedMessageId: row.saved_message_id,
    createdAt: row.created_at,
    statusChangedAt: row.status_changed_at,
    updatedAt: row.updated_at,
  }
}

export const SavedSuggestionsRepository = {
  /**
   * Insert suggestions, skipping ones that already exist for the
   * (workspace, conversation, user, title) tuple (INV-20 — re-processed
   * conversations must not duplicate). Returns only the rows actually
   * inserted, so callers broadcast exactly the new suggestions.
   */
  async insertMany(db: Querier, params: InsertSuggestionParams[]): Promise<SavedSuggestion[]> {
    if (params.length === 0) return []
    // jsonb_to_recordset (not unnest): a per-row text[] column can't be
    // unnested from a parallel-array form without the 2D-array flattening
    // footgun, so each row's source_message_ids rides as a JSON array and is
    // rebuilt with jsonb_array_elements_text. Still one set-based statement.
    const rows = params.map((p) => ({
      id: savedSuggestionId(),
      workspace_id: p.workspaceId,
      user_id: p.userId,
      stream_id: p.streamId,
      conversation_id: p.conversationId,
      title: p.title,
      context: p.context,
      source_message_ids: p.sourceMessageIds,
      due_at: p.dueAt ? p.dueAt.toISOString() : null,
      confidence: p.confidence,
    }))
    const result = await db.query<SavedSuggestionRow>(sql`
      INSERT INTO saved_suggestions (
        id, workspace_id, user_id, stream_id, conversation_id,
        title, context, source_message_ids, due_at, confidence
      )
      SELECT
        x.id, x.workspace_id, x.user_id, x.stream_id, x.conversation_id,
        x.title, x.context,
        ARRAY(SELECT jsonb_array_elements_text(x.source_message_ids)),
        x.due_at, x.confidence
      FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS x(
        id text, workspace_id text, user_id text, stream_id text, conversation_id text,
        title text, context text, source_message_ids jsonb, due_at timestamptz, confidence real
      )
      ON CONFLICT (workspace_id, conversation_id, user_id, title) DO NOTHING
      RETURNING ${sql.raw(COLUMNS)}
    `)
    return result.rows.map(mapRow)
  },

  async findById(db: Querier, workspaceId: string, userId: string, id: string): Promise<SavedSuggestion | null> {
    const result = await db.query<SavedSuggestionRow>(sql`
      SELECT ${sql.raw(COLUMNS)}
      FROM saved_suggestions
      WHERE id = ${id} AND workspace_id = ${workspaceId} AND user_id = ${userId}
    `)
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },

  /** Titles already suggested for a conversation (any status) — dedup input for the extractor. */
  async findTitlesByConversation(db: Querier, workspaceId: string, conversationId: string): Promise<string[]> {
    const result = await db.query<{ title: string }>(sql`
      SELECT title FROM saved_suggestions
      WHERE workspace_id = ${workspaceId} AND conversation_id = ${conversationId}
    `)
    return result.rows.map((r) => r.title)
  },

  /** Recently dismissed titles in a stream — negative examples for the extractor. */
  async findDismissedTitlesByStream(
    db: Querier,
    workspaceId: string,
    streamId: string,
    limit: number
  ): Promise<string[]> {
    const result = await db.query<{ title: string }>(sql`
      SELECT title FROM saved_suggestions
      WHERE workspace_id = ${workspaceId}
        AND stream_id = ${streamId}
        AND status = ${SavedSuggestionStatuses.DISMISSED}
      ORDER BY status_changed_at DESC
      LIMIT ${limit}
    `)
    return result.rows.map((r) => r.title)
  },

  async listByUser(
    db: Querier,
    workspaceId: string,
    userId: string,
    opts: ListSuggestionsOpts
  ): Promise<SavedSuggestion[]> {
    const limit = opts.limit ?? 50
    const hasCursor = opts.cursor !== undefined
    const cursor = opts.cursor ?? ""
    const result = await db.query<SavedSuggestionRow>(sql`
      SELECT ${sql.raw(COLUMNS)}
      FROM saved_suggestions
      WHERE workspace_id = ${workspaceId}
        AND user_id = ${userId}
        AND status = ${opts.status}
        AND (${!hasCursor} OR created_at < (
          SELECT created_at FROM saved_suggestions
          WHERE id = ${cursor} AND workspace_id = ${workspaceId} AND user_id = ${userId}
        ))
      ORDER BY created_at DESC
      LIMIT ${limit}
    `)
    return result.rows.map(mapRow)
  },

  /**
   * Transition status with a guarded UPDATE (INV-20). The `expectedStatus`
   * predicate makes accept/dismiss idempotent: a second accept finds no
   * suggested row and returns null instead of double-creating a saved item.
   * `savedMessageId` is pinned on accept so the suggestion deep-links to the
   * item it produced.
   */
  async updateStatus(
    db: Querier,
    workspaceId: string,
    userId: string,
    id: string,
    params: { status: SavedSuggestionStatus; expectedStatus: SavedSuggestionStatus; savedMessageId?: string | null }
  ): Promise<SavedSuggestion | null> {
    const result = await db.query<SavedSuggestionRow>(sql`
      UPDATE saved_suggestions SET
        status = ${params.status},
        saved_message_id = COALESCE(${params.savedMessageId ?? null}, saved_message_id),
        status_changed_at = NOW(),
        updated_at = NOW()
      WHERE id = ${id}
        AND workspace_id = ${workspaceId}
        AND user_id = ${userId}
        AND status = ${params.expectedStatus}
      RETURNING ${sql.raw(COLUMNS)}
    `)
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },
}
