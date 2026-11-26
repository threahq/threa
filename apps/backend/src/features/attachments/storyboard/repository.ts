import { sql, type Querier } from "../../../db"
import { StoryboardRowStatuses, type StoryboardRowStatus } from "./config"

interface VideoStoryboardRow {
  workspace_id: string
  attachment_id: string
  status: string
  storage_path: string | null
  tile_columns: number | null
  tile_rows: number | null
  tile_width: number | null
  tile_height: number | null
  tile_count: number | null
  interval_ms: number | null
  error_message: string | null
  created_at: Date
  completed_at: Date | null
}

export interface VideoStoryboardRecord {
  workspaceId: string
  attachmentId: string
  status: StoryboardRowStatus
  storagePath: string | null
  columns: number | null
  rows: number | null
  tileWidth: number | null
  tileHeight: number | null
  tileCount: number | null
  intervalMs: number | null
  errorMessage: string | null
  createdAt: Date
  completedAt: Date | null
}

export interface StoryboardResult {
  storagePath: string
  columns: number
  rows: number
  tileWidth: number
  tileHeight: number
  tileCount: number
  intervalMs: number
}

function mapRow(row: VideoStoryboardRow): VideoStoryboardRecord {
  return {
    workspaceId: row.workspace_id,
    attachmentId: row.attachment_id,
    status: row.status as StoryboardRowStatus,
    storagePath: row.storage_path,
    columns: row.tile_columns,
    rows: row.tile_rows,
    tileWidth: row.tile_width,
    tileHeight: row.tile_height,
    tileCount: row.tile_count,
    intervalMs: row.interval_ms,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  }
}

export const VideoStoryboardRepository = {
  async find(querier: Querier, workspaceId: string, attachmentId: string): Promise<VideoStoryboardRecord | null> {
    const result = await querier.query<VideoStoryboardRow>(sql`
      SELECT * FROM video_storyboards
      WHERE workspace_id = ${workspaceId} AND attachment_id = ${attachmentId}
    `)
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },

  /** True only for the caller whose insert created the row. */
  async insertPending(querier: Querier, workspaceId: string, attachmentId: string): Promise<boolean> {
    const result = await querier.query(sql`
      INSERT INTO video_storyboards (workspace_id, attachment_id)
      VALUES (${workspaceId}, ${attachmentId})
      ON CONFLICT (workspace_id, attachment_id) DO NOTHING
    `)
    return (result.rowCount ?? 0) > 0
  },

  async markReady(
    querier: Querier,
    workspaceId: string,
    attachmentId: string,
    result: StoryboardResult
  ): Promise<boolean> {
    const updated = await querier.query(sql`
      UPDATE video_storyboards
      SET status = ${StoryboardRowStatuses.READY},
          storage_path = ${result.storagePath},
          tile_columns = ${result.columns},
          tile_rows = ${result.rows},
          tile_width = ${result.tileWidth},
          tile_height = ${result.tileHeight},
          tile_count = ${result.tileCount},
          interval_ms = ${result.intervalMs},
          completed_at = NOW()
      WHERE workspace_id = ${workspaceId} AND attachment_id = ${attachmentId} AND status = ${StoryboardRowStatuses.PENDING}
    `)
    return (updated.rowCount ?? 0) > 0
  },

  async markFailed(
    querier: Querier,
    workspaceId: string,
    attachmentId: string,
    errorMessage: string
  ): Promise<boolean> {
    const updated = await querier.query(sql`
      UPDATE video_storyboards
      SET status = ${StoryboardRowStatuses.FAILED}, error_message = ${errorMessage}, completed_at = NOW()
      WHERE workspace_id = ${workspaceId} AND attachment_id = ${attachmentId} AND status = ${StoryboardRowStatuses.PENDING}
    `)
    return (updated.rowCount ?? 0) > 0
  },

  async deleteByAttachmentId(querier: Querier, workspaceId: string, attachmentId: string): Promise<void> {
    await querier.query(sql`
      DELETE FROM video_storyboards WHERE workspace_id = ${workspaceId} AND attachment_id = ${attachmentId}
    `)
  },
}
