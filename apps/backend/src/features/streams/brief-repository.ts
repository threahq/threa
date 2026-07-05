import { AuthorTypes } from "@threa/types"
import type { Querier } from "../../db"
import { sql } from "../../db"

/** Who last wrote the brief. Users edit via API/UI; personas via the 4.2 tool. */
export type BriefAuthorKind = typeof AuthorTypes.USER | typeof AuthorTypes.PERSONA

interface StreamBriefRow {
  id: string
  workspace_id: string
  stream_id: string
  content: string
  version: number
  updated_by_kind: string
  updated_by_id: string
  created_at: Date
  updated_at: Date
}

export interface StreamBrief {
  id: string
  workspaceId: string
  streamId: string
  content: string
  version: number
  updatedByKind: BriefAuthorKind
  updatedById: string
  createdAt: Date
  updatedAt: Date
}

export interface InsertFirstVersionParams {
  id: string
  workspaceId: string
  streamId: string
  content: string
  updatedByKind: BriefAuthorKind
  updatedById: string
}

export interface UpdateAtVersionParams {
  workspaceId: string
  streamId: string
  content: string
  expectedVersion: number
  updatedByKind: BriefAuthorKind
  updatedById: string
}

export interface InsertRevisionParams {
  id: string
  workspaceId: string
  briefId: string
  streamId: string
  version: number
  content: string
  updatedByKind: BriefAuthorKind
  updatedById: string
}

const COLUMNS = `
  id, workspace_id, stream_id, content, version, updated_by_kind, updated_by_id,
  created_at, updated_at
`

function mapRow(row: StreamBriefRow): StreamBrief {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    streamId: row.stream_id,
    content: row.content,
    version: row.version,
    updatedByKind: row.updated_by_kind as BriefAuthorKind,
    updatedById: row.updated_by_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export const StreamBriefRepository = {
  async findByStreamId(db: Querier, workspaceId: string, streamId: string): Promise<StreamBrief | null> {
    const result = await db.query<StreamBriefRow>(sql`
      SELECT ${sql.raw(COLUMNS)} FROM stream_briefs
      WHERE workspace_id = ${workspaceId} AND stream_id = ${streamId}
    `)
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },

  /**
   * Create the brief at version 1. `ON CONFLICT DO NOTHING` makes the
   * create-vs-create race a single statement (INV-20): the loser gets `null`
   * back — the same version-conflict outcome as an optimistic-update miss.
   */
  async insertFirstVersion(db: Querier, params: InsertFirstVersionParams): Promise<StreamBrief | null> {
    const result = await db.query<StreamBriefRow>(sql`
      INSERT INTO stream_briefs (id, workspace_id, stream_id, content, version, updated_by_kind, updated_by_id)
      VALUES (${params.id}, ${params.workspaceId}, ${params.streamId}, ${params.content}, 1,
              ${params.updatedByKind}, ${params.updatedById})
      ON CONFLICT (stream_id) DO NOTHING
      RETURNING ${sql.raw(COLUMNS)}
    `)
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },

  /**
   * Optimistic-concurrency update (INV-20): only applies when the stored
   * version is exactly `expectedVersion`. `null` means the caller lost the
   * race (or the brief doesn't exist) — no row was written.
   */
  async updateAtVersion(db: Querier, params: UpdateAtVersionParams): Promise<StreamBrief | null> {
    const result = await db.query<StreamBriefRow>(sql`
      UPDATE stream_briefs
      SET content = ${params.content},
          version = version + 1,
          updated_by_kind = ${params.updatedByKind},
          updated_by_id = ${params.updatedById},
          updated_at = NOW()
      WHERE workspace_id = ${params.workspaceId}
        AND stream_id = ${params.streamId}
        AND version = ${params.expectedVersion}
      RETURNING ${sql.raw(COLUMNS)}
    `)
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },

  /** Append-only audit trail: one row per accepted write, in the same transaction. */
  async insertRevision(db: Querier, params: InsertRevisionParams): Promise<void> {
    await db.query(sql`
      INSERT INTO stream_brief_revisions (id, workspace_id, brief_id, stream_id, version, content,
                                          updated_by_kind, updated_by_id)
      VALUES (${params.id}, ${params.workspaceId}, ${params.briefId}, ${params.streamId}, ${params.version},
              ${params.content}, ${params.updatedByKind}, ${params.updatedById})
    `)
  },
}
