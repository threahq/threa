import type { Querier } from "@threahq/backend-common"
import type { StreamConnectionSnapshot, StreamConnectionState, Visibility } from "@threahq/types"

interface StreamConnectionRow {
  id: string
  host_workspace_id: string
  host_stream_id: string
  partner_workspace_id: string | null
  state: StreamConnectionState
  expires_at: Date
}

interface SnapshotRow {
  id: string
  revision: number
  state: StreamConnectionState
  host_workspace_id: string
  host_workspace_name: string
  host_region: string
  host_stream_id: string
  invited_by: string
  partner_workspace_id: string | null
  partner_workspace_name: string | null
  partner_region: string | null
  partner_visibility: Visibility | null
  accepted_by: string | null
  peer_workspace_ids: string[]
  expires_at: Date
}

export type StreamConnectionRecord = {
  id: string
  hostWorkspaceId: string
  hostStreamId: string
  partnerWorkspaceId: string | null
  state: StreamConnectionState
  expiresAt: Date
}

export interface ChannelPartner {
  connectionId: string
  workspaceId: string
  workspaceName: string
}

export interface InsertStreamConnectionParams {
  id: string
  hostWorkspaceId: string
  hostStreamId: string
  invitedBy: string
  tokenHash: string
  expiresAt: Date
}

export interface ActivateStreamConnectionParams {
  id: string
  partnerWorkspaceId: string
  partnerVisibility: Visibility
  acceptedBy: string
}

const RECORD_COLUMNS = "id, host_workspace_id, host_stream_id, partner_workspace_id, state, expires_at"

// A connection's peers are the channel's other partners. They're derived on
// every read rather than stored, so a partner joining changes each connection's
// fan-out without rewriting its row; the accept bumps their revisions instead.
const SNAPSHOT_SELECT = `
  SELECT sc.id, sc.revision, sc.state, sc.host_workspace_id, hw.name AS host_workspace_name,
         hw.region AS host_region, sc.host_stream_id, sc.invited_by, sc.partner_workspace_id, pw.name AS partner_workspace_name, pw.region AS partner_region,
         sc.partner_visibility, sc.accepted_by, sc.expires_at,
         ARRAY(
           SELECT peer.partner_workspace_id FROM stream_connections peer
           WHERE peer.host_workspace_id = sc.host_workspace_id AND peer.host_stream_id = sc.host_stream_id
             AND peer.state = 'active' AND peer.partner_workspace_id <> sc.partner_workspace_id
           ORDER BY peer.partner_workspace_id
         ) AS peer_workspace_ids
  FROM stream_connections sc
  JOIN workspace_registry hw ON hw.id = sc.host_workspace_id
  LEFT JOIN workspace_registry pw ON pw.id = sc.partner_workspace_id`

function mapRecord(row: StreamConnectionRow): StreamConnectionRecord {
  return {
    id: row.id,
    hostWorkspaceId: row.host_workspace_id,
    hostStreamId: row.host_stream_id,
    partnerWorkspaceId: row.partner_workspace_id,
    state: row.state,
    expiresAt: row.expires_at,
  }
}

function mapSnapshot(row: SnapshotRow): StreamConnectionSnapshot {
  return {
    id: row.id,
    revision: row.revision,
    state: row.state,
    hostWorkspaceId: row.host_workspace_id,
    hostWorkspaceName: row.host_workspace_name,
    hostRegion: row.host_region,
    hostStreamId: row.host_stream_id,
    invitedBy: row.invited_by,
    partnerWorkspaceId: row.partner_workspace_id,
    partnerWorkspaceName: row.partner_workspace_name,
    partnerRegion: row.partner_region,
    partnerVisibility: row.partner_visibility,
    acceptedBy: row.accepted_by,
    peerWorkspaceIds: row.peer_workspace_ids,
    expiresAt: row.expires_at.toISOString(),
  }
}

export const StreamConnectionRepository = {
  async insert(db: Querier, params: InsertStreamConnectionParams): Promise<void> {
    await db.query(
      `INSERT INTO stream_connections (id, host_workspace_id, host_stream_id, invited_by, state, token_hash, expires_at)
       VALUES ($1, $2, $3, $4, 'invited', $5, $6)`,
      [params.id, params.hostWorkspaceId, params.hostStreamId, params.invitedBy, params.tokenHash, params.expiresAt]
    )
  },

  /** Serializes changes to one channel's links and partners until the transaction ends. */
  async lockChannel(db: Querier, hostWorkspaceId: string, hostStreamId: string): Promise<void> {
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `stream_connections:${hostWorkspaceId}:${hostStreamId}`,
    ])
  },

  /** Links of the channel still waiting for a workspace to accept them. */
  async countPendingInvites(db: Querier, hostWorkspaceId: string, hostStreamId: string): Promise<number> {
    const result = await db.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM stream_connections
       WHERE host_workspace_id = $1 AND host_stream_id = $2 AND state = 'invited' AND expires_at > NOW()`,
      [hostWorkspaceId, hostStreamId]
    )
    return Number(result.rows[0].count)
  },

  /** Locks the connection a token names. Call inside a transaction. */
  async lockByTokenHash(db: Querier, tokenHash: string): Promise<StreamConnectionRecord | null> {
    const result = await db.query<StreamConnectionRow>(
      `SELECT ${RECORD_COLUMNS} FROM stream_connections WHERE token_hash = $1 FOR UPDATE`,
      [tokenHash]
    )
    return result.rows[0] ? mapRecord(result.rows[0]) : null
  },

  /** Call inside a transaction. */
  async lockById(db: Querier, id: string): Promise<StreamConnectionRecord | null> {
    const result = await db.query<StreamConnectionRow>(
      `SELECT ${RECORD_COLUMNS} FROM stream_connections WHERE id = $1 FOR UPDATE`,
      [id]
    )
    return result.rows[0] ? mapRecord(result.rows[0]) : null
  },

  /** invited → revoked. Callers hold the row lock. */
  async revokeInvite(db: Querier, id: string): Promise<void> {
    await db.query(
      `UPDATE stream_connections
       SET state = 'revoked', revision = revision + 1, updated_at = NOW()
       WHERE id = $1 AND state = 'invited'`,
      [id]
    )
  },

  /** invited → active. Callers hold the channel lock and the row lock. */
  async activate(db: Querier, params: ActivateStreamConnectionParams): Promise<void> {
    await db.query(
      `UPDATE stream_connections
       SET state = 'active', partner_workspace_id = $2, partner_visibility = $3, accepted_by = $4,
           revision = revision + 1, updated_at = NOW()
       WHERE id = $1 AND state = 'invited'`,
      [params.id, params.partnerWorkspaceId, params.partnerVisibility, params.acceptedBy]
    )
  },

  /**
   * A change to a connection's peers changes its snapshot, so its revision
   * moves too; regions drop a snapshot whose revision they already hold.
   */
  async bumpRevisions(db: Querier, ids: string[]): Promise<void> {
    if (ids.length === 0) return
    await db.query(
      `UPDATE stream_connections SET revision = revision + 1, updated_at = NOW() WHERE id = ANY($1::text[])`,
      [ids]
    )
  },

  /** The workspaces that have accepted an invite to the channel, by name. */
  async listPartners(db: Querier, hostWorkspaceId: string, hostStreamId: string): Promise<ChannelPartner[]> {
    const result = await db.query<{ id: string; partner_workspace_id: string; name: string }>(
      `SELECT sc.id, sc.partner_workspace_id, pw.name
       FROM stream_connections sc
       JOIN workspace_registry pw ON pw.id = sc.partner_workspace_id
       WHERE sc.host_workspace_id = $1 AND sc.host_stream_id = $2 AND sc.state = 'active'
       ORDER BY pw.name, sc.id`,
      [hostWorkspaceId, hostStreamId]
    )
    return result.rows.map((row) => ({
      connectionId: row.id,
      workspaceId: row.partner_workspace_id,
      workspaceName: row.name,
    }))
  },

  /** Current state with both workspaces' names and regions from the registry. */
  async findSnapshot(db: Querier, id: string): Promise<StreamConnectionSnapshot | null> {
    const result = await db.query<SnapshotRow>(`${SNAPSHOT_SELECT} WHERE sc.id = $1`, [id])
    return result.rows[0] ? mapSnapshot(result.rows[0]) : null
  },

  async findSnapshotByTokenHash(db: Querier, tokenHash: string): Promise<StreamConnectionSnapshot | null> {
    const result = await db.query<SnapshotRow>(`${SNAPSHOT_SELECT} WHERE sc.token_hash = $1`, [tokenHash])
    return result.rows[0] ? mapSnapshot(result.rows[0]) : null
  },

  /**
   * Every connection of a channel that the workspace holds a projection row
   * for, by the rule the fan-out uses: host, partner or peer. Settled
   * connections come back only when named in `includeIds`, so the list stays
   * bounded while a region can still learn that a row it shows went stale.
   */
  async listSnapshotsForWorkspace(
    db: Querier,
    params: { workspaceId: string; streamId: string; includeIds: string[] }
  ): Promise<StreamConnectionSnapshot[]> {
    const result = await db.query<SnapshotRow>(
      `SELECT * FROM (${SNAPSHOT_SELECT} WHERE sc.host_stream_id = $2) snapshot
       WHERE (host_workspace_id = $1 OR partner_workspace_id = $1 OR $1 = ANY(peer_workspace_ids))
         AND (
           state = 'active'
           OR (state = 'invited' AND expires_at > NOW())
           OR id = ANY($3::text[])
         )
       ORDER BY id`,
      [params.workspaceId, params.streamId, params.includeIds]
    )
    return result.rows.map(mapSnapshot)
  },
}
