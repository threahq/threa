import { createHash, randomBytes, randomInt } from "node:crypto"
import type { Pool } from "pg"
import { HttpError, botConnectRequestId } from "@threa/backend-common"
import { BotConnectRepository, type BotConnectRequestRow } from "./repository"

export const BOT_CONNECT_REQUEST_TTL_MS = 15 * 60 * 1000
export const BOT_CONNECT_POLL_INTERVAL_SECONDS = 3
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

export interface StartedBotConnect {
  deviceCode: string
  userCode: string
  verificationUrl: string
  expiresAt: string
  intervalSeconds: number
}

export type BotConnectPollResult =
  | { status: "pending" | "denied" | "expired" | "claimed" }
  | {
      status: "approved"
      baseUrl: string
      workspaceId: string
      workspaceName: string
      botId: string
      botSlug: string
      apiKey: string
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
  constructor(private readonly deps: Dependencies) {}

  async start(input: { requestedName: string | null; requestedHost: string | null }): Promise<StartedBotConnect> {
    await BotConnectRepository.purgeExpired(this.deps.pool)
    const deviceCode = randomBytes(32).toString("base64url")
    const expiresAt = new Date(Date.now() + BOT_CONNECT_REQUEST_TTL_MS)
    for (let attempt = 0; attempt < 5; attempt++) {
      const userCode = mintUserCode()
      const inserted = await BotConnectRepository.insert(this.deps.pool, {
        id: botConnectRequestId(),
        deviceCodeHash: hashDeviceCode(deviceCode),
        userCode,
        requestedName: input.requestedName,
        requestedHost: input.requestedHost,
        expiresAt,
      })
      if (!inserted) continue
      return {
        deviceCode,
        userCode: formatUserCode(userCode),
        verificationUrl: `${this.deps.frontendUrl.replace(/\/$/, "")}/connect?code=${formatUserCode(userCode)}`,
        expiresAt: expiresAt.toISOString(),
        intervalSeconds: BOT_CONNECT_POLL_INTERVAL_SECONDS,
      }
    }
    throw new HttpError("Could not allocate a connect code", { status: 503, code: "BOT_CONNECT_UNAVAILABLE" })
  }

  async poll(deviceCode: string): Promise<BotConnectPollResult> {
    const row = await BotConnectRepository.findByDeviceCodeHash(this.deps.pool, hashDeviceCode(deviceCode))
    if (!row) throw new HttpError("Unknown connect request", { status: 404, code: "BOT_CONNECT_NOT_FOUND" })
    if (row.status === "denied") return { status: "denied" }
    if (row.status === "claimed") return { status: "claimed" }
    if (row.expires_at.getTime() <= Date.now()) return { status: "expired" }
    if (row.status === "pending") return { status: "pending" }
    const claimed = await BotConnectRepository.claim(this.deps.pool, row.id)
    // Lost the race with a concurrent poll, or expired between the reads.
    if (!claimed) return { status: "claimed" }
    return {
      status: "approved",
      baseUrl: this.deps.frontendUrl.replace(/\/$/, ""),
      workspaceId: claimed.approved_workspace_id!,
      workspaceName: claimed.approved_workspace_name!,
      botId: claimed.approved_bot_id!,
      botSlug: claimed.approved_bot_slug!,
      apiKey: claimed.api_key!,
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
    apiKey: string
  }): Promise<void> {
    const row = await this.pendingByUserCode(input.rawCode)
    if (!(await this.deps.membership.isMember(input.workspaceId, input.workosUserId))) {
      throw new HttpError("Not a member of that workspace", { status: 403, code: "FORBIDDEN" })
    }
    const approved = await BotConnectRepository.approve(this.deps.pool, {
      id: row.id,
      workspaceId: input.workspaceId,
      workspaceName: input.workspaceName,
      botId: input.botId,
      botSlug: input.botSlug,
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
