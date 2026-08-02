import { sql, type Querier } from "../../db"

export interface PerformanceCaptureRow {
  id: string
  workspaceId: string
  userId: string
  captureId: string
  appVersion: string
  deviceClass: string
  startedAt: Date
  sampleCount: number
  byteSize: number
  samples: unknown
  createdAt: Date
}

export interface InsertPerformanceCaptureInput {
  id: string
  workspaceId: string
  userId: string
  captureId: string
  appVersion: string
  deviceClass: string
  startedAt: string
  sampleCount: number
  byteSize: number
  samples: unknown
}

interface PerformanceCaptureDbRow {
  id: string
  workspace_id: string
  user_id: string
  capture_id: string
  app_version: string
  device_class: string
  started_at: Date
  sample_count: number
  byte_size: number
  samples: unknown
  created_at: Date
}

function mapRow(row: PerformanceCaptureDbRow): PerformanceCaptureRow {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    userId: row.user_id,
    captureId: row.capture_id,
    appVersion: row.app_version,
    deviceClass: row.device_class,
    startedAt: row.started_at,
    sampleCount: row.sample_count,
    byteSize: row.byte_size,
    samples: row.samples,
    createdAt: row.created_at,
  }
}

export const PerformanceCaptureRepository = {
  async insert(db: Querier, input: InsertPerformanceCaptureInput): Promise<void> {
    await db.query(sql`
      INSERT INTO performance_captures (
        id, workspace_id, user_id, capture_id, app_version, device_class,
        started_at, sample_count, byte_size, samples
      )
      VALUES (
        ${input.id}, ${input.workspaceId}, ${input.userId}, ${input.captureId}, ${input.appVersion},
        ${input.deviceClass}, ${input.startedAt}, ${input.sampleCount}, ${input.byteSize},
        ${JSON.stringify(input.samples)}::jsonb
      )
    `)
  },

  /** A user's captures, newest first. Workspace-scoped (INV-8). */
  async listForUser(db: Querier, workspaceId: string, userId: string, limit: number): Promise<PerformanceCaptureRow[]> {
    const result = await db.query<PerformanceCaptureDbRow>(sql`
      SELECT id, workspace_id, user_id, capture_id, app_version, device_class,
             started_at, sample_count, byte_size, samples, created_at
      FROM performance_captures
      WHERE workspace_id = ${workspaceId}
        AND user_id = ${userId}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `)
    return result.rows.map(mapRow)
  },

  /**
   * Deletes one bounded batch of captures created before `cutoff`. Bounded
   * rather than one sweeping DELETE so a first run over a backlog never holds a
   * long transaction; the eligible set only shrinks, so re-running converges.
   */
  async pruneOlderThan(db: Querier, params: { cutoff: Date; limit: number }): Promise<{ deletedCount: number }> {
    const result = await db.query(sql`
      WITH victims AS (
        SELECT ctid
        FROM performance_captures
        WHERE created_at < ${params.cutoff}
        LIMIT ${params.limit}
      )
      DELETE FROM performance_captures c
      USING victims v
      WHERE c.ctid = v.ctid
    `)
    return { deletedCount: result.rowCount ?? 0 }
  },
}
