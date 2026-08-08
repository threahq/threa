import type { Querier } from "../../db"
import { sql } from "../../db"

export const BotChannelAccessRepository = {
  async filterGrantedStreamIds(
    db: Querier,
    workspaceId: string,
    botId: string,
    streamIds: readonly string[]
  ): Promise<Set<string>> {
    if (streamIds.length === 0) return new Set()
    const result = await db.query<{ stream_id: string }>(sql`
      SELECT stream_id
      FROM bot_channel_access
      WHERE workspace_id = ${workspaceId}
        AND bot_id = ${botId}
        AND stream_id = ANY(${streamIds as string[]})
    `)
    return new Set(result.rows.map((row) => row.stream_id))
  },

  async getGrantedStreamIds(db: Querier, workspaceId: string, botId: string): Promise<string[]> {
    const result = await db.query<{ stream_id: string }>(sql`
      SELECT a.stream_id FROM bot_channel_access a
      JOIN streams s ON s.id = a.stream_id
      WHERE a.workspace_id = ${workspaceId}
        AND a.bot_id = ${botId}
        AND s.archived_at IS NULL
    `)
    return result.rows.map((r) => r.stream_id)
  },

  /**
   * Idempotent grant. Returns true when a new row was inserted, false when the
   * grant already existed. Callers rely on this to decide whether to emit
   * state-transition events without a separate pre-check (INV-20).
   */
  async grantAccess(
    db: Querier,
    params: { id: string; workspaceId: string; botId: string; streamId: string; grantedBy: string }
  ): Promise<boolean> {
    const result = await db.query(sql`
      INSERT INTO bot_channel_access (id, workspace_id, bot_id, stream_id, granted_by)
      VALUES (${params.id}, ${params.workspaceId}, ${params.botId}, ${params.streamId}, ${params.grantedBy})
      ON CONFLICT (workspace_id, bot_id, stream_id) DO NOTHING
      RETURNING id
    `)
    return result.rowCount === 1
  },

  /**
   * Returns true when a row was deleted, false when no grant existed. Callers
   * use this to skip emitting state-transition events on no-op revokes.
   */
  async revokeAccess(db: Querier, workspaceId: string, botId: string, streamId: string): Promise<boolean> {
    const result = await db.query(sql`
      DELETE FROM bot_channel_access
      WHERE workspace_id = ${workspaceId}
        AND bot_id = ${botId}
        AND stream_id = ${streamId}
      RETURNING id
    `)
    return (result.rowCount ?? 0) > 0
  },

  async revokeAllByBot(db: Querier, workspaceId: string, botId: string): Promise<void> {
    await db.query(sql`
      DELETE FROM bot_channel_access
      WHERE workspace_id = ${workspaceId}
        AND bot_id = ${botId}
    `)
  },

  async hasGrant(db: Querier, workspaceId: string, botId: string, streamId: string): Promise<boolean> {
    const result = await db.query(sql`
      SELECT EXISTS(
        SELECT 1 FROM bot_channel_access
        WHERE workspace_id = ${workspaceId} AND bot_id = ${botId} AND stream_id = ${streamId}
      ) AS granted
    `)
    return result.rows[0].granted
  },

  async getGrantedBotIds(db: Querier, workspaceId: string, streamId: string): Promise<string[]> {
    const result = await db.query<{ bot_id: string }>(sql`
      SELECT a.bot_id FROM bot_channel_access a
      JOIN bots b ON b.id = a.bot_id
      WHERE a.workspace_id = ${workspaceId}
        AND a.stream_id = ${streamId}
        AND b.archived_at IS NULL
    `)
    return result.rows.map((r) => r.bot_id)
  },

  async listGrants(
    db: Querier,
    workspaceId: string,
    botId: string
  ): Promise<Array<{ streamId: string; grantedBy: string; grantedAt: Date }>> {
    const result = await db.query<{ stream_id: string; granted_by: string; granted_at: Date }>(sql`
      SELECT a.stream_id, a.granted_by, a.granted_at
      FROM bot_channel_access a
      JOIN streams s ON s.id = a.stream_id
      WHERE a.workspace_id = ${workspaceId}
        AND a.bot_id = ${botId}
        AND s.archived_at IS NULL
      ORDER BY a.granted_at DESC
    `)
    return result.rows.map((r) => ({ streamId: r.stream_id, grantedBy: r.granted_by, grantedAt: r.granted_at }))
  },
}
