import type { Querier } from "../../db"
import { sql } from "../../db"

export type InvitedAgentKind = "bot" | "enclave" | "none"

interface E2eStreamRow {
  stream_id: string
  workspace_id: string
  enabled_at: Date
  owner_user_id: string
  owner_user_key_id: string
  invited_agent_kind: InvitedAgentKind
  invited_agent_key_id: string | null
}

export interface E2eStream {
  streamId: string
  workspaceId: string
  enabledAt: Date
  ownerUserId: string
  ownerUserKeyId: string
  invitedAgentKind: InvitedAgentKind
  invitedAgentKeyId: string | null
}

export interface MarkStreamE2eParams {
  streamId: string
  workspaceId: string
  ownerUserId: string
  ownerUserKeyId: string
  invitedAgentKind: InvitedAgentKind
  invitedAgentKeyId: string | null
}

const COLUMNS =
  "stream_id, workspace_id, enabled_at, owner_user_id, owner_user_key_id, invited_agent_kind, invited_agent_key_id"

function mapRow(row: E2eStreamRow): E2eStream {
  return {
    streamId: row.stream_id,
    workspaceId: row.workspace_id,
    enabledAt: row.enabled_at,
    ownerUserId: row.owner_user_id,
    ownerUserKeyId: row.owner_user_key_id,
    invitedAgentKind: row.invited_agent_kind,
    invitedAgentKeyId: row.invited_agent_key_id,
  }
}

export const E2eStreamsRepository = {
  async isE2eStream(db: Querier, workspaceId: string, streamId: string): Promise<boolean> {
    const result = await db.query<{ exists: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1 FROM e2e_streams
        WHERE workspace_id = ${workspaceId} AND stream_id = ${streamId}
      ) AS exists
    `)
    return result.rows[0]?.exists ?? false
  },

  /**
   * Return the subset of `streamIds` that are E2E in this workspace.
   * Used by the search service to partition a user's accessible streams
   * into plaintext (server-searchable) vs E2E (skip + count for the
   * "X encrypted streams excluded" indicator).
   */
  async filterE2eStreamIds(db: Querier, workspaceId: string, streamIds: string[]): Promise<string[]> {
    if (streamIds.length === 0) return []
    const result = await db.query<{ stream_id: string }>(sql`
      SELECT stream_id
      FROM e2e_streams
      WHERE workspace_id = ${workspaceId} AND stream_id = ANY(${streamIds})
    `)
    return result.rows.map((row) => row.stream_id)
  },

  async getByStreamId(db: Querier, workspaceId: string, streamId: string): Promise<E2eStream | null> {
    const result = await db.query<E2eStreamRow>(sql`
      SELECT ${sql.raw(COLUMNS)}
      FROM e2e_streams
      WHERE workspace_id = ${workspaceId} AND stream_id = ${streamId}
      LIMIT 1
    `)
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },

  async markStreamE2e(db: Querier, params: MarkStreamE2eParams): Promise<E2eStream> {
    const result = await db.query<E2eStreamRow>(sql`
      INSERT INTO e2e_streams (
        stream_id, workspace_id, owner_user_id, owner_user_key_id,
        invited_agent_kind, invited_agent_key_id
      )
      VALUES (
        ${params.streamId},
        ${params.workspaceId},
        ${params.ownerUserId},
        ${params.ownerUserKeyId},
        ${params.invitedAgentKind},
        ${params.invitedAgentKeyId}
      )
      RETURNING ${sql.raw(COLUMNS)}
    `)
    return mapRow(result.rows[0]!)
  },
}
