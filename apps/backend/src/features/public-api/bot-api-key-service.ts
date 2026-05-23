import { createHash, randomBytes, timingSafeEqual } from "crypto"
import type { Pool } from "pg"
import { withTransaction, sql } from "../../db"
import { BotApiKeyRepository, type BotApiKeyRow } from "./bot-api-key-repository"
import { botApiKeyId } from "../../lib/id"
import { HttpError } from "@threa/backend-common"
import type { WorkspacePermissionSlug } from "@threa/types"
import { API_KEY_ELIGIBLE_SCOPES, BOT_KEY_PREFIX } from "@threa/types"

const KEY_BYTE_LENGTH = 32
const STORED_PREFIX_LENGTH = 8

const ELIGIBLE_SCOPES = new Set<WorkspacePermissionSlug>(API_KEY_ELIGIBLE_SCOPES)
const MAX_ACTIVE_KEYS_PER_BOT = 25

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
  return BOT_KEY_PREFIX + randomBytes(KEY_BYTE_LENGTH).toString("base64url")
}

export interface ValidatedBotApiKey {
  id: string
  workspaceId: string
  botId: string
  name: string
  scopes: Set<string>
}

export class BotApiKeyService {
  private pool: Pool

  constructor(pool: Pool) {
    this.pool = pool
  }

  async createKey(params: {
    workspaceId: string
    botId: string
    name: string
    scopes: WorkspacePermissionSlug[]
    expiresAt: Date | null
  }): Promise<{ row: BotApiKeyRow; value: string }> {
    validateScopes(params.scopes)

    const value = generateKeyValue()
    const keyHash = hashKey(value)
    const keyPrefix = value.slice(BOT_KEY_PREFIX.length, BOT_KEY_PREFIX.length + STORED_PREFIX_LENGTH)

    // Atomic bot-check + count-check + insert to prevent keys on archived bots
    // and exceeding the key limit (INV-20)
    const row = await withTransaction(this.pool, async (client) => {
      // Lock the bot row to prevent concurrent archive from creating a TOCTOU gap
      const { rows: botRows } = await client.query<{ id: string; archived_at: Date | null }>(sql`
        SELECT id, archived_at FROM bots
        WHERE id = ${params.botId} AND workspace_id = ${params.workspaceId}
        FOR UPDATE
      `)
      if (botRows.length === 0 || botRows[0].archived_at !== null) {
        throw new HttpError("Bot not found or archived", { status: 404, code: "NOT_FOUND" })
      }

      const { rows: lockedRows } = await client.query<{ id: string }>(sql`
        SELECT id
        FROM bot_api_keys
        WHERE workspace_id = ${params.workspaceId}
          AND bot_id = ${params.botId}
          AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > NOW())
        FOR UPDATE
      `)
      if (lockedRows.length >= MAX_ACTIVE_KEYS_PER_BOT) {
        throw new HttpError(`Maximum of ${MAX_ACTIVE_KEYS_PER_BOT} active API keys per bot`, {
          status: 400,
          code: "KEY_LIMIT_REACHED",
        })
      }

      return BotApiKeyRepository.insert(client, {
        id: botApiKeyId(),
        workspaceId: params.workspaceId,
        botId: params.botId,
        name: params.name,
        keyHash,
        keyPrefix,
        scopes: params.scopes,
        expiresAt: params.expiresAt,
      })
    })

    return { row, value }
  }

  async listKeys(workspaceId: string, botId: string): Promise<BotApiKeyRow[]> {
    return BotApiKeyRepository.listByBot(this.pool, workspaceId, botId)
  }

  async updateScopes(params: {
    workspaceId: string
    botId: string
    keyId: string
    scopes: WorkspacePermissionSlug[]
  }): Promise<BotApiKeyRow> {
    validateScopes(params.scopes)
    const row = await BotApiKeyRepository.updateScopesOwned(
      this.pool,
      params.workspaceId,
      params.botId,
      params.keyId,
      params.scopes
    )
    if (!row) {
      throw new HttpError("API key not found", { status: 404, code: "NOT_FOUND" })
    }
    return row
  }

  async revokeKey(workspaceId: string, botId: string, keyId: string): Promise<void> {
    const result = await BotApiKeyRepository.revokeOwned(this.pool, workspaceId, botId, keyId)
    if (result === "not_found") {
      throw new HttpError("API key not found", { status: 404, code: "NOT_FOUND" })
    }
    if (result === "already_revoked") {
      throw new HttpError("API key already revoked", { status: 400, code: "ALREADY_REVOKED" })
    }
  }

  /**
   * Validate a bot API key value. Returns the key context if valid, null otherwise.
   * Also updates last_used_at as a fire-and-forget side effect.
   */
  async validateKey(value: string): Promise<ValidatedBotApiKey | null> {
    if (!value.startsWith(BOT_KEY_PREFIX)) return null

    const keyPrefix = value.slice(BOT_KEY_PREFIX.length, BOT_KEY_PREFIX.length + STORED_PREFIX_LENGTH)
    const candidates = await BotApiKeyRepository.findActiveByPrefix(this.pool, keyPrefix)
    if (candidates.length === 0) return null

    const keyHash = hashKey(value)
    const keyHashBuf = Buffer.from(keyHash, "hex")
    const match = candidates.find((k) => {
      const candidateBuf = Buffer.from(k.keyHash, "hex")
      return candidateBuf.length === keyHashBuf.length && timingSafeEqual(candidateBuf, keyHashBuf)
    })
    if (!match) return null

    // Fire-and-forget last_used_at update — non-critical, don't block response
    BotApiKeyRepository.touchLastUsed(this.pool, match.id).catch(() => {})

    return {
      id: match.id,
      workspaceId: match.workspaceId,
      botId: match.botId,
      name: match.name,
      scopes: new Set(match.scopes),
    }
  }
}
