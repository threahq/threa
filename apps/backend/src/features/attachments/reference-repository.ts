import { sql, type Querier } from "../../db"
import { listAccessibleStreamIds } from "../streams"

interface AttachmentReferenceRow {
  id: string
  workspace_id: string
  attachment_id: string
  message_id: string
  stream_id: string
  created_at: Date
}

export interface AttachmentReference {
  id: string
  workspaceId: string
  attachmentId: string
  messageId: string
  streamId: string
  createdAt: Date
}

export interface InsertAttachmentReferenceParams {
  id: string
  workspaceId: string
  attachmentId: string
  messageId: string
  streamId: string
}

function mapRow(row: AttachmentReferenceRow): AttachmentReference {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    attachmentId: row.attachment_id,
    messageId: row.message_id,
    streamId: row.stream_id,
    createdAt: row.created_at,
  }
}

const SELECT_FIELDS = `id, workspace_id, attachment_id, message_id, stream_id, created_at`

export const AttachmentReferenceRepository = {
  /**
   * Insert one row per (attachment, referencing message) pair. Idempotent so
   * repeat sends of the same payload during a retry don't error out and the
   * backfill can coexist with application-level inserts.
   */
  async insertMany(client: Querier, params: InsertAttachmentReferenceParams[]): Promise<number> {
    if (params.length === 0) return 0
    const ids = params.map((p) => p.id)
    const workspaceIds = params.map((p) => p.workspaceId)
    const attachmentIds = params.map((p) => p.attachmentId)
    const messageIds = params.map((p) => p.messageId)
    const streamIds = params.map((p) => p.streamId)
    const result = await client.query(sql`
      INSERT INTO attachment_references (id, workspace_id, attachment_id, message_id, stream_id)
      SELECT * FROM UNNEST(
        ${ids}::text[],
        ${workspaceIds}::text[],
        ${attachmentIds}::text[],
        ${messageIds}::text[],
        ${streamIds}::text[]
      )
      ON CONFLICT (workspace_id, attachment_id, message_id) DO NOTHING
    `)
    return result.rowCount ?? 0
  },

  /**
   * Wipe every reference row owned by a single message. Used by the edit
   * path so it can rewrite the projection from the new contentJson without
   * leaving stale rows behind when the author removed (or swapped) an
   * `attachment:` link. Workspace-scoped (INV-8) so a stranger's message id
   * can never collateral-delete another workspace's rows.
   */
  async deleteByMessageId(client: Querier, workspaceId: string, messageId: string): Promise<number> {
    const result = await client.query(sql`
      DELETE FROM attachment_references
      WHERE workspace_id = ${workspaceId}
        AND message_id = ${messageId}
    `)
    return result.rowCount ?? 0
  },

  async findByAttachmentId(db: Querier, workspaceId: string, attachmentId: string): Promise<AttachmentReference[]> {
    const result = await db.query<AttachmentReferenceRow>(sql`
      SELECT ${sql.raw(SELECT_FIELDS)}
      FROM attachment_references
      WHERE workspace_id = ${workspaceId}
        AND attachment_id = ${attachmentId}
    `)
    return result.rows.map(mapRow)
  },

  /**
   * Distinct stream IDs that contain a message referencing the attachment.
   * The shared primitive both access-control paths build on:
   * `AttachmentService.getAccessible` intersects this with the caller's
   * pre-resolved `accessibleStreamIds`; `hasViewerAccessByReference` runs
   * `listAccessibleStreamIds` over it to resolve the viewer's reach.
   * Keeping the projection in one place means the access rule can't drift
   * between the two callers.
   */
  async findReferencingStreamIds(db: Querier, workspaceId: string, attachmentId: string): Promise<string[]> {
    const refs = await this.findByAttachmentId(db, workspaceId, attachmentId)
    return [...new Set(refs.map((r) => r.streamId))]
  },

  async hasViewerAccessByReference(
    db: Querier,
    workspaceId: string,
    userId: string,
    attachmentId: string
  ): Promise<boolean> {
    const candidateStreamIds = await this.findReferencingStreamIds(db, workspaceId, attachmentId)
    if (candidateStreamIds.length === 0) return false
    const reachable = await listAccessibleStreamIds(db, workspaceId, userId, candidateStreamIds)
    return reachable.size > 0
  },
}
