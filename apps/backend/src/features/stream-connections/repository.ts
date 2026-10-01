import { sql, type Querier } from "../../db"
import type {
  StreamConnection,
  StreamConnectionRole,
  StreamConnectionSnapshot,
  StreamConnectionState,
  Visibility,
} from "@threahq/types"

interface StreamConnectionRow {
  id: string
  role: StreamConnectionRole
  state: StreamConnectionState
  stream_id: string
  stream_slug: string | null
  stream_display_name: string | null
  remote_workspace_id: string | null
  remote_workspace_name: string | null
  partner_visibility: Visibility | null
  expires_at: Date
}

const COLUMNS = `id, role, state, stream_id, stream_slug, stream_display_name,
  remote_workspace_id, remote_workspace_name, partner_visibility, expires_at`

function mapRow(row: StreamConnectionRow): StreamConnection {
  return {
    id: row.id,
    role: row.role,
    state: row.state,
    streamId: row.stream_id,
    streamSlug: row.stream_slug,
    streamDisplayName: row.stream_display_name,
    remoteWorkspaceId: row.remote_workspace_id,
    remoteWorkspaceName: row.remote_workspace_name,
    partnerVisibility: row.partner_visibility,
    expiresAt: row.expires_at.toISOString(),
  }
}

export const StreamConnectionRepository = {
  /**
   * Projects the snapshot onto each side whose workspace lives in this region,
   * keeping the stored row when it already holds this revision or a newer one.
   * Returns how many sides are local, so a snapshot sent to the wrong region
   * is caught rather than dropped.
   */
  async applySnapshot(db: Querier, s: StreamConnectionSnapshot): Promise<number> {
    const result = await db.query<{ local_sides: number }>(sql`
      WITH side (role, workspace_id, remote_workspace_id, remote_workspace_name) AS (
        VALUES
          ('host', ${s.hostWorkspaceId}::text, ${s.partnerWorkspaceId}::text, ${s.partnerWorkspaceName}::text),
          ('partner', ${s.partnerWorkspaceId}::text, ${s.hostWorkspaceId}::text, ${s.hostWorkspaceName}::text)
      ),
      local_side AS (
        SELECT side.* FROM side JOIN workspaces w ON w.id = side.workspace_id
      ),
      upserted AS (
        INSERT INTO stream_connections (
          workspace_id, id, role, state, stream_id, stream_slug, stream_display_name,
          remote_workspace_id, remote_workspace_name, partner_visibility, expires_at, revision
        )
        SELECT
          workspace_id, ${s.id}, role, ${s.state}, ${s.hostStreamId}, ${s.hostStreamSlug}, ${s.hostStreamDisplayName},
          remote_workspace_id, remote_workspace_name, ${s.partnerVisibility}, ${s.expiresAt}::timestamptz, ${s.revision}
        FROM local_side
        ON CONFLICT (workspace_id, id) DO UPDATE SET
          state = EXCLUDED.state,
          stream_slug = EXCLUDED.stream_slug,
          stream_display_name = EXCLUDED.stream_display_name,
          remote_workspace_id = EXCLUDED.remote_workspace_id,
          remote_workspace_name = EXCLUDED.remote_workspace_name,
          partner_visibility = EXCLUDED.partner_visibility,
          expires_at = EXCLUDED.expires_at,
          revision = EXCLUDED.revision,
          updated_at = NOW()
        WHERE stream_connections.revision < EXCLUDED.revision
      )
      SELECT COUNT(*)::int AS local_sides FROM local_side
    `)
    return result.rows[0].local_sides
  },

  async findById(db: Querier, workspaceId: string, id: string): Promise<StreamConnection | null> {
    const result = await db.query<StreamConnectionRow>(sql`
      SELECT ${sql.raw(COLUMNS)}
      FROM stream_connections
      WHERE workspace_id = ${workspaceId} AND id = ${id}
    `)
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },

  /** The channel's pending invite or accepted share, newest first. */
  async listLiveForStream(db: Querier, workspaceId: string, streamId: string): Promise<StreamConnection[]> {
    const result = await db.query<StreamConnectionRow>(sql`
      SELECT ${sql.raw(COLUMNS)}
      FROM stream_connections
      WHERE workspace_id = ${workspaceId} AND stream_id = ${streamId} AND state IN ('invited', 'active')
      ORDER BY created_at DESC
    `)
    return result.rows.map(mapRow)
  },
}
