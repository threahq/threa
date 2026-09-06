import type { Querier } from "../../../db"
import { sql } from "../../../db"
import { type ShareFlavor } from "@threahq/types"
import { listAccessibleStreamIds, listRoomReadableStreamIds } from "../../streams"

// Internal row type (snake_case, not exported)
interface SharedMessageRow {
  id: string
  workspace_id: string
  share_message_id: string
  source_message_id: string
  source_stream_id: string
  target_stream_id: string
  flavor: string
  created_by: string
  created_at: Date
}

// Domain type (camelCase, exported)
export interface SharedMessage {
  id: string
  workspaceId: string
  shareMessageId: string
  sourceMessageId: string
  sourceStreamId: string
  targetStreamId: string
  flavor: ShareFlavor
  createdBy: string
  createdAt: Date
}

export interface InsertSharedMessageParams {
  id: string
  workspaceId: string
  shareMessageId: string
  sourceMessageId: string
  sourceStreamId: string
  targetStreamId: string
  flavor: ShareFlavor
  createdBy: string
}

function mapRow(row: SharedMessageRow): SharedMessage {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    shareMessageId: row.share_message_id,
    sourceMessageId: row.source_message_id,
    sourceStreamId: row.source_stream_id,
    targetStreamId: row.target_stream_id,
    flavor: row.flavor as ShareFlavor,
    createdBy: row.created_by,
    createdAt: row.created_at,
  }
}

const SELECT_FIELDS = `
  id, workspace_id, share_message_id, source_message_id, source_stream_id,
  target_stream_id, flavor, created_by, created_at
`

export const SharedMessageRepository = {
  async insert(db: Querier, params: InsertSharedMessageParams): Promise<SharedMessage> {
    const result = await db.query<SharedMessageRow>(sql`
      INSERT INTO shared_messages (
        id, workspace_id, share_message_id, source_message_id, source_stream_id,
        target_stream_id, flavor, created_by
      )
      VALUES (
        ${params.id}, ${params.workspaceId}, ${params.shareMessageId}, ${params.sourceMessageId},
        ${params.sourceStreamId}, ${params.targetStreamId}, ${params.flavor}, ${params.createdBy}
      )
      RETURNING ${sql.raw(SELECT_FIELDS)}
    `)
    return mapRow(result.rows[0])
  },

  /**
   * Returns every share-row whose source is one of the given message ids,
   * scoped to `workspaceId` (INV-8). Used by the outbox handler to find
   * target streams to invalidate when a source message is edited or deleted,
   * and by hydration to resolve per-viewer access grants on pointer renders.
   */
  async listBySourceMessageIds(db: Querier, workspaceId: string, sourceMessageIds: string[]): Promise<SharedMessage[]> {
    if (sourceMessageIds.length === 0) return []
    const result = await db.query<SharedMessageRow>(sql`
      SELECT ${sql.raw(SELECT_FIELDS)}
      FROM shared_messages
      WHERE workspace_id = ${workspaceId}
        AND source_message_id = ANY(${sourceMessageIds})
    `)
    return result.rows.map(mapRow)
  },

  /**
   * Remove every share-row created by a given share-message. Used on edit
   * to make share-recording idempotent: the service deletes existing rows
   * for a `share_message_id` and re-inserts from the new content, so the
   * row set always reflects the current message body.
   */
  async deleteByShareMessageId(db: Querier, workspaceId: string, shareMessageId: string): Promise<void> {
    await db.query(sql`
      DELETE FROM shared_messages
      WHERE workspace_id = ${workspaceId}
        AND share_message_id = ${shareMessageId}
    `)
  },

  /**
   * Returns the subset of `sourceMessageIds` for which the viewer has been
   * granted read access via at least one share whose `target_stream_id` the
   * viewer can access. Composes with {@link listAccessibleStreamIds} so the
   * "can the viewer read this stream?" rule lives in one place.
   *
   * Used by recursive pointer hydration to decide per-viewer access at each
   * level of a re-share chain: a viewer who isn't a member of the source
   * stream still sees the source content if any share grant reaches them.
   */
  async listSourcesGrantedToViewer(
    db: Querier,
    workspaceId: string,
    userId: string,
    sourceMessageIds: readonly string[]
  ): Promise<Set<string>> {
    if (sourceMessageIds.length === 0) return new Set()
    const candidates = await db.query<{ source_message_id: string; target_stream_id: string }>(sql`
      SELECT DISTINCT source_message_id, target_stream_id
      FROM shared_messages
      WHERE workspace_id = ${workspaceId}
        AND source_message_id = ANY(${sourceMessageIds as string[]})
    `)
    if (candidates.rows.length === 0) return new Set()
    const targetIds = [...new Set(candidates.rows.map((r) => r.target_stream_id))]
    const accessibleTargets = await listAccessibleStreamIds(db, workspaceId, userId, targetIds)
    if (accessibleTargets.size === 0) return new Set()
    return new Set(
      candidates.rows.filter((r) => accessibleTargets.has(r.target_stream_id)).map((r) => r.source_message_id)
    )
  },

  /**
   * Returns the subset of `sourceMessageIds` granted via at least one share
   * whose `target_stream_id` is in the caller-supplied `accessibleStreamIds`
   * set. The set-based analog of {@link listSourcesGrantedToViewer} for
   * callers that already resolved their readable streams once (the public API
   * key principal): one grant query, in-memory set intersection, no per-viewer
   * membership round-trip (INV-56).
   */
  async listSourcesGrantedToAnyStream(
    db: Querier,
    workspaceId: string,
    accessibleStreamIds: ReadonlySet<string>,
    sourceMessageIds: readonly string[]
  ): Promise<Set<string>> {
    if (sourceMessageIds.length === 0 || accessibleStreamIds.size === 0) return new Set()
    const candidates = await db.query<{ source_message_id: string; target_stream_id: string }>(sql`
      SELECT DISTINCT source_message_id, target_stream_id
      FROM shared_messages
      WHERE workspace_id = ${workspaceId}
        AND source_message_id = ANY(${sourceMessageIds as string[]})
    `)
    return new Set(
      candidates.rows.filter((r) => accessibleStreamIds.has(r.target_stream_id)).map((r) => r.source_message_id)
    )
  },

  async listSourcesGrantedToRoom(
    db: Querier,
    workspaceId: string,
    roomStreamId: string,
    sourceMessageIds: readonly string[]
  ): Promise<Set<string>> {
    if (sourceMessageIds.length === 0) return new Set()
    const candidates = await db.query<{ source_message_id: string; target_stream_id: string }>(sql`
      SELECT DISTINCT source_message_id, target_stream_id
      FROM shared_messages
      WHERE workspace_id = ${workspaceId}
        AND source_message_id = ANY(${sourceMessageIds as string[]})
    `)
    if (candidates.rows.length === 0) return new Set()
    const targetIds = [...new Set(candidates.rows.map((r) => r.target_stream_id))]
    const readableTargets = await listRoomReadableStreamIds(db, workspaceId, roomStreamId, targetIds)
    if (readableTargets.size === 0) return new Set()
    return new Set(
      candidates.rows.filter((r) => readableTargets.has(r.target_stream_id)).map((r) => r.source_message_id)
    )
  },
}
