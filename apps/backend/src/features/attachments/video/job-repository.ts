import { sql, type Querier } from "../../../db"
import type { VideoTranscodeStatus } from "@threahq/types"

interface VideoTranscodeJobRow {
  id: string
  attachment_id: string
  workspace_id: string
  mediaconvert_job_id: string | null
  status: string
  processed_storage_path: string | null
  thumbnail_storage_path: string | null
  error_message: string | null
  submitted_at: Date | null
  completed_at: Date | null
  created_at: Date
}

export interface VideoTranscodeJob {
  id: string
  attachmentId: string
  workspaceId: string
  mediaconvertJobId: string | null
  status: VideoTranscodeStatus
  processedStoragePath: string | null
  thumbnailStoragePath: string | null
  errorMessage: string | null
  submittedAt: Date | null
  completedAt: Date | null
  createdAt: Date
}

export interface InsertVideoTranscodeJobParams {
  id: string
  attachmentId: string
  workspaceId: string
}

function mapRowToJob(row: VideoTranscodeJobRow): VideoTranscodeJob {
  return {
    id: row.id,
    attachmentId: row.attachment_id,
    workspaceId: row.workspace_id,
    mediaconvertJobId: row.mediaconvert_job_id,
    status: row.status as VideoTranscodeStatus,
    processedStoragePath: row.processed_storage_path,
    thumbnailStoragePath: row.thumbnail_storage_path,
    errorMessage: row.error_message,
    submittedAt: row.submitted_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
  }
}

const SELECT_FIELDS = `
  id, attachment_id, workspace_id,
  mediaconvert_job_id, status,
  processed_storage_path, thumbnail_storage_path,
  error_message, submitted_at, completed_at, created_at
`

export const VideoTranscodeJobRepository = {
  async insert(client: Querier, params: InsertVideoTranscodeJobParams): Promise<VideoTranscodeJob> {
    const result = await client.query<VideoTranscodeJobRow>(sql`
      INSERT INTO video_transcode_jobs (id, attachment_id, workspace_id)
      VALUES (${params.id}, ${params.attachmentId}, ${params.workspaceId})
      RETURNING ${sql.raw(SELECT_FIELDS)}
    `)
    return mapRowToJob(result.rows[0])
  },

  /**
   * Insert or reset a tracking job for crash recovery (at-least-once delivery).
   * If a row already exists for this attachment, resets it to pending state so
   * the submit can retry cleanly.
   */
  async upsert(client: Querier, params: InsertVideoTranscodeJobParams): Promise<VideoTranscodeJob> {
    const result = await client.query<VideoTranscodeJobRow>(sql`
      INSERT INTO video_transcode_jobs (id, attachment_id, workspace_id)
      VALUES (${params.id}, ${params.attachmentId}, ${params.workspaceId})
      ON CONFLICT (attachment_id) DO UPDATE SET
        status = 'pending',
        mediaconvert_job_id = NULL,
        processed_storage_path = NULL,
        thumbnail_storage_path = NULL,
        error_message = NULL,
        submitted_at = NULL,
        completed_at = NULL
      RETURNING ${sql.raw(SELECT_FIELDS)}
    `)
    return mapRowToJob(result.rows[0])
  },

  async findByAttachmentId(client: Querier, attachmentId: string): Promise<VideoTranscodeJob | null> {
    const result = await client.query<VideoTranscodeJobRow>(
      sql`SELECT ${sql.raw(SELECT_FIELDS)} FROM video_transcode_jobs WHERE attachment_id = ${attachmentId}`
    )
    return result.rows[0] ? mapRowToJob(result.rows[0]) : null
  },

  async findByAttachmentIds(client: Querier, attachmentIds: string[]): Promise<Map<string, VideoTranscodeJob>> {
    if (attachmentIds.length === 0) return new Map()
    const result = await client.query<VideoTranscodeJobRow>(
      sql`SELECT ${sql.raw(SELECT_FIELDS)} FROM video_transcode_jobs WHERE attachment_id = ANY(${attachmentIds})`
    )
    const map = new Map<string, VideoTranscodeJob>()
    for (const row of result.rows) {
      map.set(row.attachment_id, mapRowToJob(row))
    }
    return map
  },

  async updateSubmitted(client: Querier, id: string, mediaconvertJobId: string): Promise<boolean> {
    const result = await client.query(sql`
      UPDATE video_transcode_jobs
      SET status = 'submitted', mediaconvert_job_id = ${mediaconvertJobId}, submitted_at = NOW()
      WHERE id = ${id} AND status = 'pending'
    `)
    return (result.rowCount ?? 0) > 0
  },

  async updateCompleted(
    client: Querier,
    id: string,
    processedStoragePath: string,
    thumbnailStoragePath: string
  ): Promise<boolean> {
    const result = await client.query(sql`
      UPDATE video_transcode_jobs
      SET status = 'completed',
          processed_storage_path = ${processedStoragePath},
          thumbnail_storage_path = ${thumbnailStoragePath},
          completed_at = NOW()
      WHERE id = ${id} AND status IN ('pending', 'submitted')
    `)
    return (result.rowCount ?? 0) > 0
  },

  async updateFailed(client: Querier, id: string, errorMessage: string): Promise<boolean> {
    const result = await client.query(sql`
      UPDATE video_transcode_jobs
      SET status = 'failed', error_message = ${errorMessage}, completed_at = NOW()
      WHERE id = ${id} AND status IN ('pending', 'submitted')
    `)
    return (result.rowCount ?? 0) > 0
  },
}
