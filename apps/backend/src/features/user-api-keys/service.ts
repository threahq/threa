import { createHash, randomBytes, timingSafeEqual } from "crypto"
import type { Pool } from "pg"
import { withTransaction, sql } from "../../db"
import { UserApiKeyRepository, type UserApiKeyRow } from "./repository"
import { userApiKeyId } from "../../lib/id"
import { HttpError } from "../../lib/errors"
import type { WorkspacePermissionSlug } from "@threa/types"
import { API_KEY_ELIGIBLE_SCOPES } from "@threa/types"

const KEY_PREFIX = "threa_uk_"
const KEY_BYTE_LENGTH = 32 // 256-bit random key
const STORED_PREFIX_LENGTH = 8 // chars stored for identification (after threa_uk_)

const ELIGIBLE_SCOPES = new Set<WorkspacePermissionSlug>(API_KEY_ELIGIBLE_SCOPES)
const MAX_ACTIVE_KEYS_PER_USER = 25

function validateScopes(scopes: WorkspacePermissionSlug[]): void {
  for (const scope of scopes) {
    if (!ELIGIBLE_SCOPES.has(scope)) {
      throw new HttpError(`Invalid scope: ${scope}`, { status: 400, code: "INVALID_SCOPE" })
    }
  }

  if (scopes.length === 0) {
    throw new HttpError("At least one scope is required", { status: 400, code: "INVALID_SCOPE" })
  }
}

function hashKey(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

function generateKeyValue(): string {
  return KEY_PREFIX + randomBytes(KEY_BYTE_LENGTH).toString("base64url")
}

export interface ValidatedUserApiKey {
  id: string
  workspaceId: string
  userId: string
  name: string
  scopes: Set<string>
}

export class UserApiKeyService {
  private pool: Pool

  constructor(pool: Pool) {
    this.pool = pool
  }

  async createKey(params: {
    workspaceId: string
    userId: string
    name: string
    scopes: WorkspacePermissionSlug[]
    expiresAt: Date | null
  }): Promise<{ row: UserApiKeyRow; value: string }> {
    validateScopes(params.scopes)

    const value = generateKeyValue()
    const keyHash = hashKey(value)
    const keyPrefix = value.slice(KEY_PREFIX.length, KEY_PREFIX.length + STORED_PREFIX_LENGTH)

    // Atomic count-check + insert in a transaction with FOR UPDATE to prevent
    // concurrent creates from exceeding the key limit (INV-20).
    // Note: SELECT id (not COUNT(*)) because FOR UPDATE is invalid with aggregates.
    const row = await withTransaction(this.pool, async (client) => {
      const { rows: lockedRows } = await client.query<{ id: string }>(sql`
        SELECT id
        FROM user_api_keys
        WHERE workspace_id = ${params.workspaceId}
          AND user_id = ${params.userId}
          AND revoked_at IS NULL
        FOR UPDATE
      `)
      if (lockedRows.length >= MAX_ACTIVE_KEYS_PER_USER) {
        throw new HttpError(`Maximum of ${MAX_ACTIVE_KEYS_PER_USER} active API keys per user`, {
          status: 400,
          code: "KEY_LIMIT_REACHED",
        })
      }

      return UserApiKeyRepository.insert(client, {
        id: userApiKeyId(),
        workspaceId: params.workspaceId,
        userId: params.userId,
        name: params.name,
        keyHash,
        keyPrefix,
        scopes: params.scopes,
        expiresAt: params.expiresAt,
      })
    })

    return { row, value }
  }

  async listKeys(workspaceId: string, userId: string): Promise<UserApiKeyRow[]> {
    return UserApiKeyRepository.listByUser(this.pool, workspaceId, userId)
  }

  async updateScopes(params: {
    workspaceId: string
    userId: string
    keyId: string
    scopes: WorkspacePermissionSlug[]
  }): Promise<UserApiKeyRow> {
    validateScopes(params.scopes)
    const row = await UserApiKeyRepository.updateScopesOwned(
      this.pool,
      params.workspaceId,
      params.userId,
      params.keyId,
      params.scopes
    )
    if (!row) {
      throw new HttpError("API key not found", { status: 404, code: "NOT_FOUND" })
    }
    return row
  }

  async revokeKey(workspaceId: string, userId: string, keyId: string): Promise<void> {
    const result = await UserApiKeyRepository.revokeOwned(this.pool, workspaceId, userId, keyId)
    if (result === "not_found") {
      throw new HttpError("API key not found", { status: 404, code: "NOT_FOUND" })
    }
    if (result === "already_revoked") {
      throw new HttpError("API key already revoked", { status: 400, code: "ALREADY_REVOKED" })
    }
  }

  /**
   * Validate a user API key value. Returns the key context if valid, null otherwise.
   * Also updates last_used_at as a fire-and-forget side effect.
   */
  async validateKey(value: string): Promise<ValidatedUserApiKey | null> {
    if (!value.startsWith(KEY_PREFIX)) return null

    const keyPrefix = value.slice(KEY_PREFIX.length, KEY_PREFIX.length + STORED_PREFIX_LENGTH)
    const candidates = await UserApiKeyRepository.findActiveByPrefix(this.pool, keyPrefix)
    if (candidates.length === 0) return null

    const keyHash = hashKey(value)
    const keyHashBuf = Buffer.from(keyHash, "hex")
    const match = candidates.find((k) => {
      const candidateBuf = Buffer.from(k.keyHash, "hex")
      return candidateBuf.length === keyHashBuf.length && timingSafeEqual(candidateBuf, keyHashBuf)
    })
    if (!match) return null

    // Fire-and-forget last_used_at update — non-critical, don't block response
    UserApiKeyRepository.touchLastUsed(this.pool, match.id).catch(() => {})

    return {
      id: match.id,
      workspaceId: match.workspaceId,
      userId: match.userId,
      name: match.name,
      scopes: new Set(match.scopes),
    }
  }
}
