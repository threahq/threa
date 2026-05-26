import type { Querier } from "../../db"
import { sql } from "../../db"

interface UserE2eKeyRow {
  id: string
  user_id: string
  workspace_id: string
  key_id: string
  public_key: Buffer
  encrypted_private_bundle: Buffer
  kdf_salt: Buffer
  kdf_params: KdfParams
  created_at: Date
  revoked_at: Date | null
}

export interface KdfParams {
  algorithm: "argon2id"
  m: number
  t: number
  p: number
  version: number
}

export interface UserE2eKey {
  id: string
  userId: string
  workspaceId: string
  keyId: string
  publicKey: Buffer
  encryptedPrivateBundle: Buffer
  kdfSalt: Buffer
  kdfParams: KdfParams
  createdAt: Date
  revokedAt: Date | null
}

export interface InsertUserE2eKeyParams {
  id: string
  userId: string
  workspaceId: string
  keyId: string
  publicKey: Buffer
  encryptedPrivateBundle: Buffer
  kdfSalt: Buffer
  kdfParams: KdfParams
}

const COLUMNS =
  "id, user_id, workspace_id, key_id, public_key, encrypted_private_bundle, kdf_salt, kdf_params, created_at, revoked_at"

function mapRow(row: UserE2eKeyRow): UserE2eKey {
  return {
    id: row.id,
    userId: row.user_id,
    workspaceId: row.workspace_id,
    keyId: row.key_id,
    publicKey: row.public_key,
    encryptedPrivateBundle: row.encrypted_private_bundle,
    kdfSalt: row.kdf_salt,
    kdfParams: row.kdf_params,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  }
}

export const UserE2eKeysRepository = {
  async getActiveByUser(db: Querier, workspaceId: string, userId: string): Promise<UserE2eKey | null> {
    const result = await db.query<UserE2eKeyRow>(sql`
      SELECT ${sql.raw(COLUMNS)}
      FROM user_e2e_keys
      WHERE workspace_id = ${workspaceId}
        AND user_id = ${userId}
        AND revoked_at IS NULL
      LIMIT 1
    `)
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },

  async getByKeyId(db: Querier, workspaceId: string, keyId: string): Promise<UserE2eKey | null> {
    const result = await db.query<UserE2eKeyRow>(sql`
      SELECT ${sql.raw(COLUMNS)}
      FROM user_e2e_keys
      WHERE workspace_id = ${workspaceId}
        AND key_id = ${keyId}
      LIMIT 1
    `)
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },

  async insert(db: Querier, params: InsertUserE2eKeyParams): Promise<UserE2eKey> {
    const result = await db.query<UserE2eKeyRow>(sql`
      INSERT INTO user_e2e_keys (
        id, user_id, workspace_id, key_id,
        public_key, encrypted_private_bundle, kdf_salt, kdf_params
      )
      VALUES (
        ${params.id},
        ${params.userId},
        ${params.workspaceId},
        ${params.keyId},
        ${params.publicKey},
        ${params.encryptedPrivateBundle},
        ${params.kdfSalt},
        ${JSON.stringify(params.kdfParams)}::jsonb
      )
      RETURNING ${sql.raw(COLUMNS)}
    `)
    return mapRow(result.rows[0]!)
  },

  async revokeActive(db: Querier, workspaceId: string, userId: string): Promise<number> {
    const result = await db.query(sql`
      UPDATE user_e2e_keys
      SET revoked_at = NOW()
      WHERE workspace_id = ${workspaceId}
        AND user_id = ${userId}
        AND revoked_at IS NULL
    `)
    return result.rowCount ?? 0
  },
}
