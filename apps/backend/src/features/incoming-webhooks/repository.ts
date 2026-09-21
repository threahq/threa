import { sql } from "../../db"
import type { Querier } from "../../db"

export interface IncomingWebhookRow {
  id: string
  workspaceId: string
  botId: string
  streamId: string
  name: string
  secretHash: string
  createdBy: string
  createdAt: Date
  lastUsedAt: Date | null
  revokedAt: Date | null
}

const SELECT_FIELDS = `
  id, workspace_id, bot_id, stream_id, name, secret_hash,
  created_by, created_at, last_used_at, revoked_at
`

function mapRow(row: Record<string, unknown>): IncomingWebhookRow {
  return {
    id: row.id as string,
    workspaceId: row.workspace_id as string,
    botId: row.bot_id as string,
    streamId: row.stream_id as string,
    name: row.name as string,
    secretHash: row.secret_hash as string,
    createdBy: row.created_by as string,
    createdAt: row.created_at as Date,
    lastUsedAt: row.last_used_at as Date | null,
    revokedAt: row.revoked_at as Date | null,
  }
}

export const IncomingWebhookRepository = {
  async insert(
    db: Querier,
    params: {
      id: string
      workspaceId: string
      botId: string
      streamId: string
      name: string
      secretHash: string
      createdBy: string
    }
  ): Promise<IncomingWebhookRow> {
    const result = await db.query<Record<string, unknown>>(sql`
      INSERT INTO incoming_webhooks (id, workspace_id, bot_id, stream_id, name, secret_hash, created_by)
      VALUES (
        ${params.id}, ${params.workspaceId}, ${params.botId}, ${params.streamId},
        ${params.name}, ${params.secretHash}, ${params.createdBy}
      )
      RETURNING ${sql.raw(SELECT_FIELDS)}
    `)
    return mapRow(result.rows[0])
  },

  async listByBot(db: Querier, workspaceId: string, botId: string): Promise<IncomingWebhookRow[]> {
    const result = await db.query<Record<string, unknown>>(sql`
      SELECT ${sql.raw(SELECT_FIELDS)}
      FROM incoming_webhooks
      WHERE workspace_id = ${workspaceId} AND bot_id = ${botId}
      ORDER BY created_at DESC
    `)
    return result.rows.map(mapRow)
  },

  async countActiveByBot(db: Querier, workspaceId: string, botId: string): Promise<number> {
    const result = await db.query<{ count: string }>(sql`
      SELECT COUNT(*)::text AS count
      FROM incoming_webhooks
      WHERE workspace_id = ${workspaceId} AND bot_id = ${botId} AND revoked_at IS NULL
    `)
    return Number(result.rows[0].count)
  },

  /** A hook that can still serve traffic: not revoked, and its bot still live. */
  async findLive(db: Querier, workspaceId: string, id: string): Promise<IncomingWebhookRow | null> {
    const result = await db.query<Record<string, unknown>>(sql`
      SELECT ${sql.raw(SELECT_FIELDS)}
      FROM incoming_webhooks
      WHERE id = ${id} AND workspace_id = ${workspaceId} AND revoked_at IS NULL
        AND EXISTS (
          SELECT 1 FROM bots
          WHERE bots.id = incoming_webhooks.bot_id
            AND bots.workspace_id = incoming_webhooks.workspace_id
            AND bots.archived_at IS NULL
        )
    `)
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },

  async revokeOwned(
    db: Querier,
    workspaceId: string,
    botId: string,
    id: string
  ): Promise<"ok" | "not_found" | "already_revoked"> {
    const result = await db.query(sql`
      UPDATE incoming_webhooks
      SET revoked_at = NOW()
      WHERE id = ${id} AND workspace_id = ${workspaceId} AND bot_id = ${botId} AND revoked_at IS NULL
    `)
    if ((result.rowCount ?? 0) > 0) return "ok"
    return (await this.existsOwned(db, workspaceId, botId, id)) ? "already_revoked" : "not_found"
  },

  async updateOwned(
    db: Querier,
    params: {
      workspaceId: string
      botId: string
      id: string
      name: string | null
      streamId: string | null
    }
  ): Promise<IncomingWebhookRow | null> {
    const result = await db.query<Record<string, unknown>>(sql`
      UPDATE incoming_webhooks
      SET name = COALESCE(${params.name}, name),
          stream_id = COALESCE(${params.streamId}, stream_id)
      WHERE id = ${params.id} AND workspace_id = ${params.workspaceId}
        AND bot_id = ${params.botId} AND revoked_at IS NULL
      RETURNING ${sql.raw(SELECT_FIELDS)}
    `)
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },

  async existsOwned(db: Querier, workspaceId: string, botId: string, id: string): Promise<boolean> {
    const result = await db.query(sql`
      SELECT 1 FROM incoming_webhooks
      WHERE id = ${id} AND workspace_id = ${workspaceId} AND bot_id = ${botId}
    `)
    return (result.rowCount ?? 0) > 0
  },

  async touchLastUsed(db: Querier, workspaceId: string, id: string): Promise<void> {
    await db.query(sql`
      UPDATE incoming_webhooks
      SET last_used_at = NOW()
      WHERE id = ${id} AND workspace_id = ${workspaceId}
    `)
  },
}
