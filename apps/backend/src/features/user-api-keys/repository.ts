import { sql } from "../../db"
import type { Querier } from "../../db"

export interface UserApiKeyRow {
  id: string
  workspaceId: string
  userId: string
  name: string
  keyHash: string
  keyPrefix: string
  scopes: string[]
  lastUsedAt: Date | null
  expiresAt: Date | null
  revokedAt: Date | null
  createdAt: Date
}

const SELECT_FIELDS = `
  id, workspace_id, user_id, name, key_hash, key_prefix, scopes,
  last_used_at, expires_at, revoked_at, created_at
`

function mapRow(row: Record<string, unknown>): UserApiKeyRow {
  return {
    id: row.id as string,
    workspaceId: row.workspace_id as string,
    userId: row.user_id as string,
    name: row.name as string,
    keyHash: row.key_hash as string,
    keyPrefix: row.key_prefix as string,
    scopes: row.scopes as string[],
    lastUsedAt: row.last_used_at as Date | null,
    expiresAt: row.expires_at as Date | null,
    revokedAt: row.revoked_at as Date | null,
    createdAt: row.created_at as Date,
  }
}

export const UserApiKeyRepository = {
  async insert(
    db: Querier,
    params: {
      id: string
      workspaceId: string
      userId: string
      name: string
      keyHash: string
      keyPrefix: string
      scopes: string[]
      expiresAt: Date | null
    }
  ): Promise<UserApiKeyRow> {
    const result = await db.query<Record<string, unknown>>(sql`
      INSERT INTO user_api_keys (id, workspace_id, user_id, name, key_hash, key_prefix, scopes, expires_at)
      VALUES (
        ${params.id}, ${params.workspaceId}, ${params.userId}, ${params.name},
        ${params.keyHash}, ${params.keyPrefix}, ${params.scopes}, ${params.expiresAt}
      )
      RETURNING ${sql.raw(SELECT_FIELDS)}
    `)
    return mapRow(result.rows[0])
  },

  async listByUser(db: Querier, workspaceId: string, userId: string): Promise<UserApiKeyRow[]> {
    const result = await db.query<Record<string, unknown>>(sql`
      SELECT ${sql.raw(SELECT_FIELDS)}
      FROM user_api_keys
      WHERE workspace_id = ${workspaceId} AND user_id = ${userId}
      ORDER BY created_at DESC
    `)
    return result.rows.map(mapRow)
  },

  async findById(db: Querier, workspaceId: string, id: string): Promise<UserApiKeyRow | null> {
    const result = await db.query<Record<string, unknown>>(sql`
      SELECT ${sql.raw(SELECT_FIELDS)}
      FROM user_api_keys
      WHERE id = ${id} AND workspace_id = ${workspaceId}
    `)
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },

  async findActiveByPrefix(db: Querier, prefix: string): Promise<UserApiKeyRow[]> {
    const result = await db.query<Record<string, unknown>>(sql`
      SELECT ${sql.raw(SELECT_FIELDS)}
      FROM user_api_keys
      WHERE key_prefix = ${prefix}
        AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > NOW())
    `)
    return result.rows.map(mapRow)
  },

  /**
   * Atomic revoke with ownership check — avoids select-then-update (INV-20).
   * Single UPDATE with all guards in the WHERE clause.
   */
  async updateScopesOwned(
    db: Querier,
    workspaceId: string,
    userId: string,
    id: string,
    scopes: string[]
  ): Promise<UserApiKeyRow | null> {
    const result = await db.query<Record<string, unknown>>(sql`
      UPDATE user_api_keys
      SET scopes = ${scopes}
      WHERE id = ${id} AND workspace_id = ${workspaceId} AND user_id = ${userId} AND revoked_at IS NULL
      RETURNING ${sql.raw(SELECT_FIELDS)}
    `)
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },

  async revokeOwned(
    db: Querier,
    workspaceId: string,
    userId: string,
    id: string
  ): Promise<"ok" | "not_found" | "already_revoked"> {
    // Try the strict UPDATE first (all conditions including revoked_at IS NULL)
    const result = await db.query(sql`
      UPDATE user_api_keys
      SET revoked_at = NOW()
      WHERE id = ${id} AND workspace_id = ${workspaceId} AND user_id = ${userId} AND revoked_at IS NULL
    `)
    if ((result.rowCount ?? 0) > 0) return "ok"

    // No rows matched — distinguish "not found / wrong owner" from "already revoked"
    const exists = await db.query(sql`
      SELECT 1 FROM user_api_keys WHERE id = ${id} AND workspace_id = ${workspaceId} AND user_id = ${userId}
    `)
    return exists.rowCount === 0 ? "not_found" : "already_revoked"
  },

  async revokeAllByUser(db: Querier, workspaceId: string, userId: string): Promise<number> {
    const result = await db.query(sql`
      UPDATE user_api_keys
      SET revoked_at = NOW()
      WHERE workspace_id = ${workspaceId} AND user_id = ${userId} AND revoked_at IS NULL
    `)
    return result.rowCount ?? 0
  },

  async touchLastUsed(db: Querier, id: string): Promise<void> {
    await db.query(sql`
      UPDATE user_api_keys SET last_used_at = NOW() WHERE id = ${id}
    `)
  },
}
