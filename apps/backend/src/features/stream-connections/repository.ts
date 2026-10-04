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
  remote_workspace_id: string | null
  remote_workspace_name: string | null
  partner_visibility: Visibility | null
  invited_by: string | null
  accepted_by: string | null
  expires_at: Date
  revision: number
}

const COLUMNS = `id, role, state, stream_id, remote_workspace_id, remote_workspace_name,
  partner_visibility, invited_by, accepted_by, expires_at, revision`

/** A projected row this apply wrote, with the workspace that holds it. */
export interface AppliedStreamConnection {
  workspaceId: string
  connection: StreamConnection
}

export interface ApplySnapshotsResult {
  /** Rows of workspaces in this region, written or not. Zero means none of the snapshots' workspaces live here. */
  localRows: number
  /** Rows the apply inserted or moved to a newer revision. */
  changed: AppliedStreamConnection[]
}

interface StreamRef {
  workspaceId: string
  streamId: string
}

export interface ConnectionRef {
  workspaceId: string
  connectionId: string
}

export interface HostConnectionRef {
  hostWorkspaceId: string
  connectionId: string
  partnerWorkspaceId: string
}

function mapRow(row: StreamConnectionRow): StreamConnection {
  return {
    id: row.id,
    role: row.role,
    state: row.state,
    revision: row.revision,
    streamId: row.stream_id,
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
   * already holds that revision or a newer one. Counts the local rows, so a
   * snapshot sent to the wrong region is caught rather than dropped. Each user
   * id is a user of one workspace and the partner's visibility is that
   * workspace's own choice, so only that workspace's row keeps them.
   */
  async applySnapshots(db: Querier, snapshots: StreamConnectionSnapshot[]): Promise<ApplySnapshotsResult> {
    if (snapshots.length === 0) return { localRows: 0, changed: [] }
    const result = await db.query<StreamConnectionRow & { local_rows: number; workspace_id: string | null }>(sql`
      WITH snapshot AS (
        SELECT * FROM jsonb_to_recordset(${JSON.stringify(snapshots)}::jsonb) AS s (
          id text, revision integer, state text, "hostWorkspaceId" text, "hostWorkspaceName" text,
          "hostStreamId" text, "invitedBy" text, "partnerWorkspaceId" text, "partnerWorkspaceName" text,
          "partnerVisibility" text, "acceptedBy" text, "peerWorkspaceIds" jsonb, "expiresAt" timestamptz
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
          workspace_id, id, role, state, stream_id, remote_workspace_id, remote_workspace_name,
          partner_visibility, invited_by, accepted_by, expires_at, revision
        )
        SELECT
          ls.workspace_id, s.id, ls.role, s.state, s."hostStreamId", ls.remote_workspace_id, ls.remote_workspace_name,
          CASE WHEN ls.role = 'partner' THEN s."partnerVisibility" END, ls.invited_by, ls.accepted_by,
          s."expiresAt", s.revision
        FROM local_side ls JOIN snapshot s ON s.id = ls.snapshot_id
        -- Concurrent applies lock rows in one order, so they queue instead of deadlocking.
        ORDER BY ls.workspace_id, s.id
        ON CONFLICT (workspace_id, id) DO UPDATE SET
          role = EXCLUDED.role,
          state = EXCLUDED.state,
          remote_workspace_id = EXCLUDED.remote_workspace_id,
          remote_workspace_name = EXCLUDED.remote_workspace_name,
          partner_visibility = EXCLUDED.partner_visibility,
          invited_by = EXCLUDED.invited_by,
          accepted_by = EXCLUDED.accepted_by,
          expires_at = EXCLUDED.expires_at,
          revision = EXCLUDED.revision,
          updated_at = NOW()
        WHERE stream_connections.revision < EXCLUDED.revision
        RETURNING workspace_id, ${sql.raw(COLUMNS)}
      )
      SELECT lc.local_rows, u.*
      FROM (SELECT COUNT(*)::int AS local_rows FROM local_side) lc
      LEFT JOIN upserted u ON true
    `)
    return {
      localRows: result.rows[0].local_rows,
      changed: result.rows.flatMap((row) =>
        row.workspace_id === null ? [] : [{ workspaceId: row.workspace_id, connection: mapRow(row) }]
      ),
    }
  },

  async findById(db: Querier, workspaceId: string, id: string): Promise<StreamConnection | null> {
    const result = await db.query<StreamConnectionRow>(sql`
      SELECT ${sql.raw(COLUMNS)}
      FROM stream_connections
      WHERE workspace_id = ${workspaceId} AND id = ${id}
    `)
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },

  /** Locks the row, so writes driven by one connection run one at a time. */
  async findByIdForUpdate(db: Querier, workspaceId: string, id: string): Promise<StreamConnection | null> {
    const result = await db.query<StreamConnectionRow>(sql`
      SELECT ${sql.raw(COLUMNS)}
      FROM stream_connections
      WHERE workspace_id = ${workspaceId} AND id = ${id}
      FOR UPDATE
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
      ORDER BY id DESC
    `)
    return result.rows.map(mapRow)
  },

  /** The active connections whose shared tree holds any of these streams, seen from each host workspace. */
  async listActiveHostConnectionsForStreams(db: Querier, refs: StreamRef[]): Promise<HostConnectionRef[]> {
    if (refs.length === 0) return []
    const result = await db.query<{ workspace_id: string; id: string; remote_workspace_id: string }>(sql`
      SELECT DISTINCT sc.workspace_id, sc.id, sc.remote_workspace_id
      FROM unnest(${refs.map((ref) => ref.workspaceId)}::text[], ${refs.map((ref) => ref.streamId)}::text[])
        AS ref(workspace_id, stream_id)
      JOIN streams s ON s.workspace_id = ref.workspace_id AND s.id = ref.stream_id
      JOIN stream_connections sc
        ON sc.workspace_id = s.workspace_id AND sc.stream_id = COALESCE(s.root_stream_id, s.id)
      WHERE sc.role = 'host' AND sc.state = 'active' AND sc.remote_workspace_id IS NOT NULL
    `)
    return result.rows.map((row) => ({
      hostWorkspaceId: row.workspace_id,
      connectionId: row.id,
      partnerWorkspaceId: row.remote_workspace_id,
    }))
  },

  /** Every active connection a workspace of this region joined as a partner. */
  async listActivePartnerConnections(db: Querier): Promise<ConnectionRef[]> {
    // eslint-disable-next-line threa/workspace-scoped-sql -- every partner connection in the region, across workspaces by design
    const result = await db.query<{ workspace_id: string; id: string }>(sql`
      SELECT workspace_id, id FROM stream_connections WHERE role = 'partner' AND state = 'active'
    `)
    return result.rows.map((row) => ({ workspaceId: row.workspace_id, connectionId: row.id }))
  },
}
