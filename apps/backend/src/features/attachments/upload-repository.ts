import { sql, type Querier } from "../../db"
import { AttachmentUploadStatuses, type AttachmentUploadStatus } from "@threa/types"

interface AttachmentUploadRow {
  id: string
  workspace_id: string
  attachment_id: string
  uploaded_by: string
  client_message_id: string | null
  draft_id: string | null
  status: string
  expected_size_bytes: string
  received_size_bytes: string | null
  error_code: string | null
  error_message: string | null
  created_at: Date
  updated_at: Date
  completed_at: Date | null
}

export interface AttachmentUpload {
  id: string
  workspaceId: string
  attachmentId: string
  uploadedBy: string
  clientMessageId: string | null
  draftId: string | null
  status: AttachmentUploadStatus
  expectedSizeBytes: number
  receivedSizeBytes: number | null
  errorCode: string | null
  errorMessage: string | null
  createdAt: Date
  updatedAt: Date
  completedAt: Date | null
}

export interface InsertAttachmentUploadParams {
  id: string
  workspaceId: string
  attachmentId: string
  uploadedBy: string
  clientMessageId?: string | null
  draftId?: string | null
  expectedSizeBytes: number
}

function mapRow(row: AttachmentUploadRow): AttachmentUpload {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    attachmentId: row.attachment_id,
    uploadedBy: row.uploaded_by,
    clientMessageId: row.client_message_id,
    draftId: row.draft_id,
    status: row.status as AttachmentUploadStatus,
    expectedSizeBytes: Number(row.expected_size_bytes),
    receivedSizeBytes: row.received_size_bytes === null ? null : Number(row.received_size_bytes),
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  }
}

const SELECT_FIELDS = `
  id, workspace_id, attachment_id, uploaded_by, client_message_id, draft_id,
  status, expected_size_bytes, received_size_bytes, error_code, error_message,
  created_at, updated_at, completed_at
`

export const AttachmentUploadRepository = {
  async insert(client: Querier, params: InsertAttachmentUploadParams): Promise<AttachmentUpload> {
    const result = await client.query<AttachmentUploadRow>(sql`
      INSERT INTO attachment_uploads (
        id, workspace_id, attachment_id, uploaded_by, client_message_id, draft_id,
        status, expected_size_bytes
      )
      VALUES (
        ${params.id}, ${params.workspaceId}, ${params.attachmentId}, ${params.uploadedBy},
        ${params.clientMessageId ?? null}, ${params.draftId ?? null},
        ${AttachmentUploadStatuses.RESERVED}, ${params.expectedSizeBytes}
      )
      RETURNING ${sql.raw(SELECT_FIELDS)}
    `)
    return mapRow(result.rows[0])
  },

  async findByAttachmentId(client: Querier, attachmentId: string): Promise<AttachmentUpload | null> {
    const result = await client.query<AttachmentUploadRow>(sql`
      SELECT ${sql.raw(SELECT_FIELDS)} FROM attachment_uploads WHERE attachment_id = ${attachmentId}
    `)
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },

  async markUploaded(
    client: Querier,
    attachmentId: string,
    receivedSizeBytes: number
  ): Promise<AttachmentUpload | null> {
    const result = await client.query<AttachmentUploadRow>(sql`
      UPDATE attachment_uploads
      SET status = ${AttachmentUploadStatuses.UPLOADED},
          received_size_bytes = ${receivedSizeBytes},
          updated_at = NOW(),
          completed_at = NOW(),
          error_code = NULL,
          error_message = NULL
      WHERE attachment_id = ${attachmentId}
        AND status = ANY(${[AttachmentUploadStatuses.RESERVED, AttachmentUploadStatuses.UPLOADING, AttachmentUploadStatuses.FAILED]})
      RETURNING ${sql.raw(SELECT_FIELDS)}
    `)
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },
}
