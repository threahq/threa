import { createHash, randomBytes, randomInt } from "node:crypto"
import type { Pool } from "pg"
import { HttpError, botConnectRequestId, logger } from "@threahq/backend-common"
import { BotConnectRepository, type BotConnectRequestRow } from "./repository"

export const BOT_CONNECT_REQUEST_TTL_MS = 15 * 60 * 1000
export const BOT_CONNECT_POLL_INTERVAL_SECONDS = 3
// Expired rows are also purged on every authorization; the sweeper covers a
// quiet deployment where the last approved-but-unclaimed row would otherwise
// keep its key until the next device shows up.
export const BOT_CONNECT_SWEEP_INTERVAL_MS = 5 * 60 * 1000
// After issuing the token the same device code can fetch it again for this
// long: a response lost between the control plane and the device would
// otherwise consume a key that was never stored anywhere.
export const BOT_CONNECT_TOKEN_REPLAY_WINDOW_MS = 60 * 1000
// No vowels or look-alikes (0/O, 1/I/L), so a code read aloud or typed from a
// phone screen survives. 8 characters from 28 symbols: ~3.8e11 combinations,
// only meaningful while a request is pending (15 minutes) and only reachable
// through a rate-limited, session-authenticated lookup.
const USER_CODE_ALPHABET = "BCDFGHJKMNPQRSTVWXYZ23456789"
const USER_CODE_LENGTH = 8

interface MembershipLookup {
  isMember(workspaceId: string, workosUserId: string): Promise<boolean>
}

interface Dependencies {
  pool: Pool
  membership: MembershipLookup
  /**
   * Where the user approves (`${frontendUrl}/connect?code=…`) and what the
   * device talks to afterwards: the app origin serves `/api/*` through the
   * edge router, so one URL covers both.
   */
  frontendUrl: string
}

/** RFC 8628 §3.2 device authorization response. */
export interface DeviceAuthorization {
  device_code: string
  user_code: string
  verification_uri: string
  verification_uri_complete: string
  expires_in: number
  interval: number
}

/**
 * RFC 8628 §3.5 token response, or one of its error codes. The access token
 * is the minted `threa_bk_` bot key: long-lived and revocable from the bot's
 * keys page, so no refresh token. The extra members tell the device where and
 * who it is; RFC 6749 §5.1 allows them.
 */
export type DeviceTokenResult =
  | { error: "authorization_pending" | "access_denied" | "expired_token" | "invalid_grant" }
  | {
      access_token: string
      token_type: "Bearer"
      scope: string
      base_url: string
      workspace_id: string
      workspace_name: string
      bot_id: string
      bot_slug: string
    }

export interface BotConnectLookup {
  userCode: string
  requestedName: string | null
  requestedHost: string | null
  expiresAt: string
}

export function hashDeviceCode(deviceCode: string): string {
  return createHash("sha256").update(deviceCode).digest("hex")
}

/** `ABCD-EFGH` and `abcdefgh` both name the same code. */
export function normalizeUserCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "")
}

export function formatUserCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`
}

function mintUserCode(): string {
  let code = ""
  for (let i = 0; i < USER_CODE_LENGTH; i++) code += USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)]
  return code
}

export class BotConnectService {
  private sweeper: ReturnType<typeof setInterval> | undefined

  constructor(private readonly deps: Dependencies) {}

  startSweeper(intervalMs = BOT_CONNECT_SWEEP_INTERVAL_MS): void {
    this.sweeper ??= setInterval(() => {
      BotConnectRepository.purgeExpired(this.deps.pool, BOT_CONNECT_TOKEN_REPLAY_WINDOW_MS).catch((error) => {
        logger.warn({ err: error }, "bot-connect sweep failed")
      })
    }, intervalMs)
    this.sweeper.unref()
  }

  stopSweeper(): void {
    if (this.sweeper) clearInterval(this.sweeper)
    this.sweeper = undefined
  }

  async authorize(input: {
    clientId: string
    requestedName: string | null
    requestedHost: string | null
  }): Promise<DeviceAuthorization> {
    await BotConnectRepository.purgeExpired(this.deps.pool, BOT_CONNECT_TOKEN_REPLAY_WINDOW_MS)
    const deviceCode = randomBytes(32).toString("base64url")
    const expiresAt = new Date(Date.now() + BOT_CONNECT_REQUEST_TTL_MS)
    for (let attempt = 0; attempt < 5; attempt++) {
      const userCode = mintUserCode()
      const inserted = await BotConnectRepository.insert(this.deps.pool, {
        id: botConnectRequestId(),
        deviceCodeHash: hashDeviceCode(deviceCode),
        userCode,
        clientId: input.clientId,
        requestedName: input.requestedName,
        requestedHost: input.requestedHost,
        expiresAt,
      })
      if (!inserted) continue
      const verificationUri = `${this.deps.frontendUrl.replace(/\/$/, "")}/connect`
      return {
        device_code: deviceCode,
        user_code: formatUserCode(userCode),
        verification_uri: verificationUri,
        verification_uri_complete: `${verificationUri}?code=${formatUserCode(userCode)}`,
        expires_in: Math.floor(BOT_CONNECT_REQUEST_TTL_MS / 1000),
        interval: BOT_CONNECT_POLL_INTERVAL_SECONDS,
      }
    }
    throw new HttpError("Could not allocate a connect code", { status: 503, code: "BOT_CONNECT_UNAVAILABLE" })
  }

  async token(deviceCode: string, clientId: string): Promise<DeviceTokenResult> {
    const row = await BotConnectRepository.findByDeviceCodeHash(this.deps.pool, hashDeviceCode(deviceCode))
    // An unknown code, an already-redeemed one, and a grant redeemed by a
    // different client than the one that asked all read the same to the
    // caller: the grant is not valid (RFC 8628 §3.4 binds the grant to the client).
    if (!row || row.client_id !== clientId) return { error: "invalid_grant" }
    if (row.status === "claimed") {
      const replayable =
        row.api_key !== null &&
        row.claimed_at !== null &&
        Date.now() - row.claimed_at.getTime() < BOT_CONNECT_TOKEN_REPLAY_WINDOW_MS
      if (replayable) return this.issue(row)
      if (row.api_key) await BotConnectRepository.clearKey(this.deps.pool, row.id)
      return { error: "invalid_grant" }
    }
    if (row.status === "denied") return { error: "access_denied" }
    if (row.expires_at.getTime() <= Date.now()) {
      if (row.api_key) await BotConnectRepository.clearKey(this.deps.pool, row.id)
      return { error: "expired_token" }
    }
    if (row.status === "pending") return { error: "authorization_pending" }
    const claimed = await BotConnectRepository.claim(this.deps.pool, row.id)
    // Lost the race with a concurrent poll (it will replay), or expired between the reads.
    if (!claimed) return { error: "invalid_grant" }
    return this.issue(claimed)
  }

  private issue(row: BotConnectRequestRow): DeviceTokenResult {
    return {
      access_token: row.api_key!,
      token_type: "Bearer",
      scope: row.approved_scope ?? "",
      base_url: this.deps.frontendUrl.replace(/\/$/, ""),
      workspace_id: row.approved_workspace_id!,
      workspace_name: row.approved_workspace_name!,
      bot_id: row.approved_bot_id!,
      bot_slug: row.approved_bot_slug!,
    }
  }

  private async pendingByUserCode(rawCode: string): Promise<BotConnectRequestRow> {
    const code = normalizeUserCode(rawCode)
    const row =
      code.length === USER_CODE_LENGTH ? await BotConnectRepository.findPendingByUserCode(this.deps.pool, code) : null
    if (!row || row.expires_at.getTime() <= Date.now()) {
      throw new HttpError("No pending connect request for that code", { status: 404, code: "BOT_CONNECT_NOT_FOUND" })
    }
    return row
  }

  async lookup(rawCode: string): Promise<BotConnectLookup> {
    const row = await this.pendingByUserCode(rawCode)
    return {
      userCode: formatUserCode(row.user_code),
      requestedName: row.requested_name,
      requestedHost: row.requested_host,
      expiresAt: row.expires_at.toISOString(),
    }
  }

  async approve(input: {
    rawCode: string
    workosUserId: string
    workspaceId: string
    workspaceName: string
    botId: string
    botSlug: string
    scope: string
    apiKey: string
  }): Promise<void> {
    let row: BotConnectRequestRow
    try {
      row = await this.pendingByUserCode(input.rawCode)
    } catch (error) {
      // A retry after a lost response: the same provisioning already
      // approved this code, so answer as it did the first time instead of
      // making the browser revoke a key the device may already hold.
      const code = normalizeUserCode(input.rawCode)
      const latest =
        code.length === USER_CODE_LENGTH ? await BotConnectRepository.findLatestByUserCode(this.deps.pool, code) : null
      const sameApproval =
        latest !== null &&
        (latest.status === "approved" || latest.status === "claimed") &&
        latest.approved_bot_id === input.botId &&
        latest.approved_workspace_id === input.workspaceId
      if (sameApproval) return
      throw error
    }
    if (!(await this.deps.membership.isMember(input.workspaceId, input.workosUserId))) {
      throw new HttpError("Not a member of that workspace", { status: 403, code: "FORBIDDEN" })
    }
    const approved = await BotConnectRepository.approve(this.deps.pool, {
      id: row.id,
      workspaceId: input.workspaceId,
      workspaceName: input.workspaceName,
      botId: input.botId,
      botSlug: input.botSlug,
      scope: input.scope,
      apiKey: input.apiKey,
      approvedByWorkosUserId: input.workosUserId,
    })
    if (!approved) {
      throw new HttpError("Connect request is no longer pending", { status: 409, code: "BOT_CONNECT_NOT_PENDING" })
    }
  }

  async deny(input: { rawCode: string; workosUserId: string }): Promise<void> {
    const row = await this.pendingByUserCode(input.rawCode)
    if (!(await BotConnectRepository.deny(this.deps.pool, row.id, input.workosUserId))) {
      throw new HttpError("Connect request is no longer pending", { status: 409, code: "BOT_CONNECT_NOT_PENDING" })
    }
  }
}
