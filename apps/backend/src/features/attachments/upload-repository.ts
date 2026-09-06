import { sql, type Querier } from "../../db"
import { AttachmentUploadStatuses, type AttachmentUploadStatus } from "@threahq/types"

interface AttachmentUploadRow {
  id: string
  workspace_id: string
  attachment_id: string
  uploaded_by: string
  status: string
  expected_size_bytes: string
  error_code: string | null
  error_message: string | null
  created_at: Date
  updated_at: Date
}

export interface AttachmentUpload {
  id: string
  workspaceId: string
  attachmentId: string
  uploadedBy: string
  status: AttachmentUploadStatus
  expectedSizeBytes: number
  errorCode: string | null
  errorMessage: string | null
  createdAt: Date
  updatedAt: Date
}

export interface InsertAttachmentUploadParams {
  id: string
  workspaceId: string
  attachmentId: string
  uploadedBy: string
  expectedSizeBytes: number
}

/** A stale row swept into `failed` or `abandoned`, joined with its bind state. */
export interface SweptAttachmentUpload {
  attachmentId: string
  workspaceId: string
  status: AttachmentUploadStatus
  messageId: string | null
  streamId: string | null
  storagePath: string | null
}

function mapRow(row: AttachmentUploadRow): AttachmentUpload {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    attachmentId: row.attachment_id,
    uploadedBy: row.uploaded_by,
    status: row.status as AttachmentUploadStatus,
    expectedSizeBytes: Number(row.expected_size_bytes),
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

const SELECT_FIELDS = `
  id, workspace_id, attachment_id, uploaded_by, status,
  expected_size_bytes, error_code, error_message, created_at, updated_at
`

/**
 * Upload states a reserved-content POST may (re)start from: fresh, a retry of
 * a dead/failed transfer, or a late resume of a swept-abandoned upload whose
 * attachment row still exists (bound to a message — landing the bytes heals it).
 */
const RESTARTABLE_UPLOAD_STATUSES: readonly AttachmentUploadStatus[] = [
  AttachmentUploadStatuses.RESERVED,
  AttachmentUploadStatuses.UPLOADING,
  AttachmentUploadStatuses.FAILED,
  AttachmentUploadStatuses.ABANDONED,
]

export const AttachmentUploadRepository = {
  RESTARTABLE_UPLOAD_STATUSES,

  async insert(client: Querier, params: InsertAttachmentUploadParams): Promise<AttachmentUpload> {
    const result = await client.query<AttachmentUploadRow>(sql`
      INSERT INTO attachment_uploads (id, workspace_id, attachment_id, uploaded_by, status, expected_size_bytes)
      VALUES (
        ${params.id}, ${params.workspaceId}, ${params.attachmentId}, ${params.uploadedBy},
        ${AttachmentUploadStatuses.RESERVED}, ${params.expectedSizeBytes}
      )
      RETURNING ${sql.raw(SELECT_FIELDS)}
    `)
    return mapRow(result.rows[0])
  },

  async findByAttachmentId(
    client: Querier,
    workspaceId: string,
    attachmentId: string
  ): Promise<AttachmentUpload | null> {
    const result = await client.query<AttachmentUploadRow>(sql`
      SELECT ${sql.raw(SELECT_FIELDS)} FROM attachment_uploads
      WHERE workspace_id = ${workspaceId} AND attachment_id = ${attachmentId}
    `)
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },

  async findByAttachmentIds(
    client: Querier,
    workspaceId: string,
    attachmentIds: string[]
  ): Promise<Map<string, AttachmentUpload>> {
    if (attachmentIds.length === 0) return new Map()
    const result = await client.query<AttachmentUploadRow>(sql`
      SELECT ${sql.raw(SELECT_FIELDS)} FROM attachment_uploads
      WHERE workspace_id = ${workspaceId} AND attachment_id = ANY(${attachmentIds})
    `)
    return new Map(result.rows.map((row) => [row.attachment_id, mapRow(row)]))
  },

  async deleteByAttachmentId(client: Querier, attachmentId: string): Promise<void> {
    await client.query(sql`DELETE FROM attachment_uploads WHERE attachment_id = ${attachmentId}`)
  },

  async deleteByAttachmentIds(client: Querier, attachmentIds: string[]): Promise<void> {
    if (attachmentIds.length === 0) return
    await client.query(sql`DELETE FROM attachment_uploads WHERE attachment_id = ANY(${attachmentIds})`)
  },

  /**
   * CAS a restartable row to `uploading` when bytes start arriving. Returns
   * null when the row is missing or already `uploaded` — the caller rejects
   * the transfer before any byte reaches S3.
   */
  async markUploading(client: Querier, workspaceId: string, attachmentId: string): Promise<AttachmentUpload | null> {
    const result = await client.query<AttachmentUploadRow>(sql`
      UPDATE attachment_uploads
      SET status = ${AttachmentUploadStatuses.UPLOADING},
          error_code = NULL,
          error_message = NULL,
          updated_at = NOW()
      WHERE workspace_id = ${workspaceId} AND attachment_id = ${attachmentId}
        AND status = ANY(${[...RESTARTABLE_UPLOAD_STATUSES]})
      RETURNING ${sql.raw(SELECT_FIELDS)}
    `)
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },

  /**
   * CAS to `uploaded` once the bytes landed. `uploaded` is a transient state
   * covering the scan window — the settle transaction deletes the row.
   */
  async markUploaded(client: Querier, workspaceId: string, attachmentId: string): Promise<AttachmentUpload | null> {
    const result = await client.query<AttachmentUploadRow>(sql`
      UPDATE attachment_uploads
      SET status = ${AttachmentUploadStatuses.UPLOADED},
          error_code = NULL,
          error_message = NULL,
          updated_at = NOW()
      WHERE workspace_id = ${workspaceId} AND attachment_id = ${attachmentId}
        AND status = ANY(${[...RESTARTABLE_UPLOAD_STATUSES]})
      RETURNING ${sql.raw(SELECT_FIELDS)}
    `)
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },

  /**
   * CAS to `failed`. `uploaded` is included because it is the transient
   * scan-window state, not a settled outcome (a settled upload has NO row —
   * the settle transaction deletes it): the concurrent-overwrite branch must
   * be able to fail a row mid-scan-window, or the row wedges at `uploaded`
   * (retries 409, and the scan-orphan sweep would falsely quarantine a
   * legitimate file 4 hours later). A racing successful settle still wins:
   * its delete removes the row whatever this wrote.
   */
  async markFailed(
    client: Querier,
    workspaceId: string,
    attachmentId: string,
    error: { code: string; message?: string | null }
  ): Promise<AttachmentUpload | null> {
    const result = await client.query<AttachmentUploadRow>(sql`
      UPDATE attachment_uploads
      SET status = ${AttachmentUploadStatuses.FAILED},
          error_code = ${error.code},
          error_message = ${error.message ?? null},
          updated_at = NOW()
      WHERE workspace_id = ${workspaceId} AND attachment_id = ${attachmentId}
        AND status = ANY(
          ${[AttachmentUploadStatuses.RESERVED, AttachmentUploadStatuses.UPLOADING, AttachmentUploadStatuses.UPLOADED]}
        )
      RETURNING ${sql.raw(SELECT_FIELDS)}
    `)
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },

  /**
   * Sweep phase 1: reserved/uploading rows idle past the threshold flip to
   * `failed` so viewers stop seeing a dead "Uploading…" chip. Joined with the
   * attachment's bind state so the caller can emit status events for bound
   * rows only. FOR UPDATE SKIP LOCKED keeps concurrent sweeps from colliding.
   */
  async failStale(client: Querier, options: { olderThan: Date; limit: number }): Promise<SweptAttachmentUpload[]> {
    const result = await client.query<{
      attachment_id: string
      workspace_id: string
      status: string
      message_id: string | null
      stream_id: string | null
      storage_path: string | null
    }>(sql`
      WITH stale AS (
        SELECT id, attachment_id
        FROM attachment_uploads
        WHERE status = ANY(${[AttachmentUploadStatuses.RESERVED, AttachmentUploadStatuses.UPLOADING]})
          AND updated_at < ${options.olderThan}
        ORDER BY updated_at ASC
        LIMIT ${options.limit}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE attachment_uploads au
      SET status = ${AttachmentUploadStatuses.FAILED},
          error_code = 'stale',
          error_message = 'Upload did not complete',
          updated_at = NOW()
      FROM stale
      LEFT JOIN attachments a ON a.id = stale.attachment_id
      WHERE au.id = stale.id
      RETURNING au.attachment_id, au.workspace_id, au.status, a.message_id, a.stream_id, a.storage_path
    `)
    return result.rows.map((row) => ({
      attachmentId: row.attachment_id,
      workspaceId: row.workspace_id,
      status: row.status as AttachmentUploadStatus,
      messageId: row.message_id,
      streamId: row.stream_id,
      storagePath: row.storage_path,
    }))
  },

  /**
   * Sweep phase 2: failed rows idle past the (much longer) threshold flip to
   * `abandoned`. Bound rows stay as tombstones (the message still renders a
   * failed chip); the caller deletes unbound attachment rows + S3 objects.
   */
  async abandonStaleFailed(
    client: Querier,
    options: { olderThan: Date; limit: number }
  ): Promise<SweptAttachmentUpload[]> {
    const result = await client.query<{
      attachment_id: string
      workspace_id: string
      status: string
      message_id: string | null
      stream_id: string | null
      storage_path: string | null
    }>(sql`
      WITH stale AS (
        SELECT id, attachment_id
        FROM attachment_uploads
        WHERE status = ${AttachmentUploadStatuses.FAILED}
          AND updated_at < ${options.olderThan}
        ORDER BY updated_at ASC
        LIMIT ${options.limit}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE attachment_uploads au
      SET status = ${AttachmentUploadStatuses.ABANDONED},
          updated_at = NOW()
      FROM stale
      LEFT JOIN attachments a ON a.id = stale.attachment_id
      WHERE au.id = stale.id
      RETURNING au.attachment_id, au.workspace_id, au.status, a.message_id, a.stream_id, a.storage_path
    `)
    return result.rows.map((row) => ({
      attachmentId: row.attachment_id,
      workspaceId: row.workspace_id,
      status: row.status as AttachmentUploadStatus,
      messageId: row.message_id,
      streamId: row.stream_id,
      storagePath: row.storage_path,
    }))
  },

  /**
   * Sweep phase 3: `uploaded` is a seconds-long scan-window state; a row stuck
   * there means the settle crashed mid-flight. The orphaned tracking row is
   * deleted and returned with its bind state so the caller can quarantine a
   * still-`pending_scan` attachment (this sweep owns reserved rows' lifecycle —
   * the startup stale-scan sweep deliberately skips them).
   */
  async deleteStaleUploaded(
    client: Querier,
    options: { olderThan: Date; limit: number }
  ): Promise<SweptAttachmentUpload[]> {
    const result = await client.query<{
      attachment_id: string
      workspace_id: string
      status: string
      message_id: string | null
      stream_id: string | null
      storage_path: string | null
    }>(sql`
      WITH stale AS (
        SELECT id, attachment_id
        FROM attachment_uploads
        WHERE status = ${AttachmentUploadStatuses.UPLOADED}
          AND updated_at < ${options.olderThan}
        ORDER BY updated_at ASC
        LIMIT ${options.limit}
        FOR UPDATE SKIP LOCKED
      )
      DELETE FROM attachment_uploads au
      USING stale
      LEFT JOIN attachments a ON a.id = stale.attachment_id
      WHERE au.id = stale.id
      RETURNING au.attachment_id, au.workspace_id, au.status, a.message_id, a.stream_id, a.storage_path
    `)
    return result.rows.map((row) => ({
      attachmentId: row.attachment_id,
      workspaceId: row.workspace_id,
      status: row.status as AttachmentUploadStatus,
      messageId: row.message_id,
      streamId: row.stream_id,
      storagePath: row.storage_path,
    }))
  },
}
