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
  invited_by: string | null
  accepted_by: string | null
  expires_at: Date
}

const COLUMNS = `id, role, state, stream_id, stream_slug, stream_display_name,
  remote_workspace_id, remote_workspace_name, partner_visibility, invited_by, accepted_by, expires_at`

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
    invitedBy: row.invited_by,
    acceptedBy: row.accepted_by,
    expiresAt: row.expires_at.toISOString(),
  }
}

export const StreamConnectionRepository = {
  /**
   * Projects each snapshot onto every workspace in this region that takes part
   * in it (the host, the partner, and each peer), keeping a stored row when it
   * already holds that revision or a newer one. Returns how many rows are
   * local, so a snapshot sent to the wrong region is caught rather than dropped.
   * Each user id is a user of one workspace, so only that workspace's row keeps it.
   */
  async applySnapshots(db: Querier, snapshots: StreamConnectionSnapshot[]): Promise<number> {
    if (snapshots.length === 0) return 0
    const result = await db.query<{ local_rows: number }>(sql`
      WITH snapshot AS (
        SELECT * FROM jsonb_to_recordset(${JSON.stringify(snapshots)}::jsonb) AS s (
          id text, revision integer, state text, "hostWorkspaceId" text, "hostWorkspaceName" text,
          "hostStreamId" text, "hostStreamSlug" text, "hostStreamDisplayName" text, "invitedBy" text,
          "partnerWorkspaceId" text, "partnerWorkspaceName" text, "partnerVisibility" text,
          "acceptedBy" text, "peerWorkspaceIds" jsonb, "expiresAt" timestamptz
        )
      ),
      side (snapshot_id, role, workspace_id, remote_workspace_id, remote_workspace_name, invited_by, accepted_by) AS (
        SELECT id, 'host', "hostWorkspaceId", "partnerWorkspaceId", "partnerWorkspaceName", "invitedBy", NULL
        FROM snapshot
        UNION ALL
        SELECT id, 'partner', "partnerWorkspaceId", "hostWorkspaceId", "hostWorkspaceName", NULL, "acceptedBy"
        FROM snapshot WHERE "partnerWorkspaceId" IS NOT NULL
        UNION ALL
        SELECT id, 'peer', peer.workspace_id, "partnerWorkspaceId", "partnerWorkspaceName", NULL, NULL
        FROM snapshot CROSS JOIN jsonb_array_elements_text("peerWorkspaceIds") AS peer (workspace_id)
      ),
      local_side AS (
        SELECT side.* FROM side JOIN workspaces w ON w.id = side.workspace_id
      ),
      upserted AS (
        INSERT INTO stream_connections (
          workspace_id, id, role, state, stream_id, stream_slug, stream_display_name, remote_workspace_id,
          remote_workspace_name, partner_visibility, invited_by, accepted_by, expires_at, revision
        )
        SELECT
          ls.workspace_id, s.id, ls.role, s.state, s."hostStreamId", s."hostStreamSlug", s."hostStreamDisplayName",
          ls.remote_workspace_id, ls.remote_workspace_name, s."partnerVisibility", ls.invited_by, ls.accepted_by,
          s."expiresAt", s.revision
        FROM local_side ls JOIN snapshot s ON s.id = ls.snapshot_id
        ON CONFLICT (workspace_id, id) DO UPDATE SET
          role = EXCLUDED.role,
          state = EXCLUDED.state,
          stream_slug = EXCLUDED.stream_slug,
          stream_display_name = EXCLUDED.stream_display_name,
          remote_workspace_id = EXCLUDED.remote_workspace_id,
          remote_workspace_name = EXCLUDED.remote_workspace_name,
          partner_visibility = EXCLUDED.partner_visibility,
          invited_by = EXCLUDED.invited_by,
          accepted_by = EXCLUDED.accepted_by,
          expires_at = EXCLUDED.expires_at,
          revision = EXCLUDED.revision,
          updated_at = NOW()
        WHERE stream_connections.revision < EXCLUDED.revision
      )
      SELECT COUNT(*)::int AS local_rows FROM local_side
    `)
    return result.rows[0].local_rows
  },

  async findById(db: Querier, workspaceId: string, id: string): Promise<StreamConnection | null> {
    const result = await db.query<StreamConnectionRow>(sql`
      SELECT ${sql.raw(COLUMNS)}
      FROM stream_connections
      WHERE workspace_id = ${workspaceId} AND id = ${id}
    `)
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },

  /** The channel's connections and invite links that still work, newest first. */
  async listLiveForStream(db: Querier, workspaceId: string, streamId: string): Promise<StreamConnection[]> {
    const result = await db.query<StreamConnectionRow>(sql`
      SELECT ${sql.raw(COLUMNS)}
      FROM stream_connections
      WHERE workspace_id = ${workspaceId} AND stream_id = ${streamId}
        AND (state = 'active' OR (state = 'invited' AND expires_at > NOW()))
      ORDER BY created_at DESC, id DESC
    `)
    return result.rows.map(mapRow)
  },
}
