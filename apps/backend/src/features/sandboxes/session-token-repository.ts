import { sql } from "../../db"
import type { Querier } from "../../db"

export interface SandboxSessionTokenRow {
  id: string
  workspaceId: string
  invokingUserId: string
  personaId: string
  sessionId: string
  streamId: string
  capturedStreamIds: string[]
  expiresAt: Date
}

const SELECT_FIELDS = `id, workspace_id, invoking_user_id, persona_id, session_id, stream_id, captured_stream_ids, expires_at`

function mapRow(row: Record<string, unknown>): SandboxSessionTokenRow {
  return {
    id: row.id as string,
    workspaceId: row.workspace_id as string,
    invokingUserId: row.invoking_user_id as string,
    personaId: row.persona_id as string,
    sessionId: row.session_id as string,
    streamId: row.stream_id as string,
    capturedStreamIds: row.captured_stream_ids as string[],
    expiresAt: row.expires_at as Date,
  }
}

export const SandboxSessionTokenRepository = {
  async insert(
    db: Querier,
    params: Omit<SandboxSessionTokenRow, "expiresAt"> & { tokenHash: string; ttlSec: number }
  ): Promise<SandboxSessionTokenRow> {
    const result = await db.query<Record<string, unknown>>(sql`
      INSERT INTO sandbox_session_tokens (
        id, workspace_id, token_hash, invoking_user_id, persona_id, session_id, stream_id,
        captured_stream_ids, expires_at
      )
      VALUES (
        ${params.id}, ${params.workspaceId}, ${params.tokenHash}, ${params.invokingUserId}, ${params.personaId},
        ${params.sessionId}, ${params.streamId}, ${params.capturedStreamIds}::text[],
        NOW() + make_interval(secs => ${params.ttlSec})
      )
      RETURNING ${sql.raw(SELECT_FIELDS)}
    `)
    return mapRow(result.rows[0]!)
  },

  async findLiveByHash(db: Querier, tokenHash: string): Promise<SandboxSessionTokenRow | null> {
    const result = await db.query<Record<string, unknown>>(sql`
      SELECT ${sql.raw(SELECT_FIELDS)}
      FROM sandbox_session_tokens
      WHERE token_hash = ${tokenHash} AND revoked_at IS NULL AND expires_at > NOW()
    `)
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },

  async revoke(db: Querier, workspaceId: string, id: string): Promise<void> {
    await db.query(sql`
      UPDATE sandbox_session_tokens
      SET revoked_at = NOW()
      WHERE workspace_id = ${workspaceId} AND id = ${id} AND revoked_at IS NULL
    `)
  },

  async deleteExpiredBefore(db: Querier, cutoffSec: number): Promise<void> {
    await db.query(sql`
      DELETE FROM sandbox_session_tokens
      WHERE expires_at < NOW() - make_interval(secs => ${cutoffSec})
    `)
  },
}
