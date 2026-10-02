import type { Querier } from "../../db"
import { sql } from "../../db"

interface AvatarUploadRow {
  id: string
  workspace_id: string
  user_id: string
  raw_s3_key: string
  replaces_avatar_url: string | null
  created_at: Date
}

export interface AvatarUpload {
  id: string
  workspaceId: string
  userId: string
  rawS3Key: string
  replacesAvatarUrl: string | null
  createdAt: Date
}

function mapRow(row: AvatarUploadRow): AvatarUpload {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    userId: row.user_id,
    rawS3Key: row.raw_s3_key,
    replacesAvatarUrl: row.replaces_avatar_url,
    createdAt: row.created_at,
  }
}

export const AvatarUploadRepository = {
  async insert(
    db: Querier,
    params: { id: string; workspaceId: string; userId: string; rawS3Key: string; replacesAvatarUrl: string | null }
  ): Promise<AvatarUpload> {
    const result = await db.query<AvatarUploadRow>(sql`
      INSERT INTO avatar_uploads (id, workspace_id, user_id, raw_s3_key, replaces_avatar_url)
      VALUES (${params.id}, ${params.workspaceId}, ${params.userId}, ${params.rawS3Key}, ${params.replacesAvatarUrl})
      RETURNING id, workspace_id, user_id, raw_s3_key, replaces_avatar_url, created_at
    `)
    return mapRow(result.rows[0])
  },

  async findById(db: Querier, workspaceId: string, id: string): Promise<AvatarUpload | null> {
    const result = await db.query<AvatarUploadRow>(sql`
      SELECT id, workspace_id, user_id, raw_s3_key, replaces_avatar_url, created_at
      FROM avatar_uploads WHERE workspace_id = ${workspaceId} AND id = ${id}
    `)
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },

  async deleteById(db: Querier, workspaceId: string, id: string): Promise<void> {
    await db.query(sql`DELETE FROM avatar_uploads WHERE workspace_id = ${workspaceId} AND id = ${id}`)
  },

  async deleteByUserId(db: Querier, workspaceId: string, userId: string): Promise<void> {
    await db.query(sql`DELETE FROM avatar_uploads WHERE workspace_id = ${workspaceId} AND user_id = ${userId}`)
  },
}
