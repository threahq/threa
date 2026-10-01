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
  host_stream_slug: string | null
  host_stream_display_name: string | null
  partner_workspace_id: string | null
  partner_workspace_name: string | null
  partner_region: string | null
  partner_visibility: Visibility | null
  invited_by_user_id: string
  accepted_by_user_id: string | null
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

export interface InsertStreamConnectionParams {
  id: string
  hostWorkspaceId: string
  hostStreamId: string
  hostStreamSlug: string | null
  hostStreamDisplayName: string | null
  tokenHash: string
  invitedByUserId: string
  expiresAt: Date
}

export interface ActivateStreamConnectionParams {
  id: string
  partnerWorkspaceId: string
  partnerVisibility: Visibility
  acceptedByUserId: string
}

const RECORD_COLUMNS = "id, host_workspace_id, host_stream_id, partner_workspace_id, state, expires_at"

const SNAPSHOT_SELECT = `
  SELECT sc.id, sc.revision, sc.state, sc.host_workspace_id, hw.name AS host_workspace_name,
         hw.region AS host_region, sc.host_stream_id, sc.host_stream_slug, sc.host_stream_display_name,
         sc.partner_workspace_id, pw.name AS partner_workspace_name, pw.region AS partner_region,
         sc.partner_visibility, sc.invited_by_user_id, sc.accepted_by_user_id, sc.expires_at
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
    hostStreamSlug: row.host_stream_slug,
    hostStreamDisplayName: row.host_stream_display_name,
    partnerWorkspaceId: row.partner_workspace_id,
    partnerWorkspaceName: row.partner_workspace_name,
    partnerRegion: row.partner_region,
    partnerVisibility: row.partner_visibility,
    invitedByUserId: row.invited_by_user_id,
    acceptedByUserId: row.accepted_by_user_id,
    expiresAt: row.expires_at.toISOString(),
  }
}

export const StreamConnectionRepository = {
  async insert(db: Querier, params: InsertStreamConnectionParams): Promise<void> {
    await db.query(
      `INSERT INTO stream_connections (
         id, host_workspace_id, host_stream_id, host_stream_slug, host_stream_display_name,
         state, token_hash, invited_by_user_id, expires_at
       ) VALUES ($1, $2, $3, $4, $5, 'invited', $6, $7, $8)`,
      [
        params.id,
        params.hostWorkspaceId,
        params.hostStreamId,
        params.hostStreamSlug,
        params.hostStreamDisplayName,
        params.tokenHash,
        params.invitedByUserId,
        params.expiresAt,
      ]
    )
  },

  /** Locks the channel's live connection, if any. Call inside a transaction. */
  async lockLiveForStream(
    db: Querier,
    hostWorkspaceId: string,
    hostStreamId: string
  ): Promise<StreamConnectionRecord | null> {
    const result = await db.query<StreamConnectionRow>(
      `SELECT ${RECORD_COLUMNS} FROM stream_connections
       WHERE host_workspace_id = $1 AND host_stream_id = $2 AND state IN ('invited', 'active')
       FOR UPDATE`,
      [hostWorkspaceId, hostStreamId]
    )
    return result.rows[0] ? mapRecord(result.rows[0]) : null
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

  /** invited → active. Callers hold the row lock. */
  async activate(db: Querier, params: ActivateStreamConnectionParams): Promise<void> {
    await db.query(
      `UPDATE stream_connections
       SET state = 'active', partner_workspace_id = $2, partner_visibility = $3, accepted_by_user_id = $4,
           revision = revision + 1, updated_at = NOW()
       WHERE id = $1 AND state = 'invited'`,
      [params.id, params.partnerWorkspaceId, params.partnerVisibility, params.acceptedByUserId]
    )
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
}
