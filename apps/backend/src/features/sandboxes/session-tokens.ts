import { createHash, randomBytes } from "crypto"
import type { Pool } from "pg"
import { sandboxSessionTokenId } from "../../lib/id"
import { listAccessibleStreamIds } from "../streams"
import { resolveUserAccessibleStreamIds, type SearchFilters } from "../search"
import { E2eStreamsRepository } from "../e2e-streams"
import { SandboxSessionTokenRepository, type SandboxSessionTokenRow } from "./session-token-repository"

export const SANDBOX_TOKEN_PREFIX = "threa_sk_"
const TOKEN_BYTE_LENGTH = 32
/** Expired rows stay this long for incident review, then go at the next mint. */
const EXPIRED_RETENTION_SEC = 24 * 60 * 60

export type SandboxSession = SandboxSessionTokenRow

function hashToken(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

/**
 * Tokens for code in an agent's sandbox. A token reads what the agent could
 * read in the turn that minted it (`capturedStreamIds`), and only while the
 * invoking user still can: every read re-runs the canonical access predicate
 * for that user (INV-62), then drops E2EE-rooted streams, whose plaintext the
 * server never holds.
 */
export class SandboxSessionTokenService {
  private readonly pool: Pool

  constructor(deps: { pool: Pool }) {
    this.pool = deps.pool
  }

  async mint(params: {
    workspaceId: string
    invokingUserId: string
    personaId: string
    sessionId: string
    streamId: string
    capturedStreamIds: string[]
    ttlSec: number
  }): Promise<{ session: SandboxSession; value: string }> {
    await SandboxSessionTokenRepository.deleteExpiredBefore(this.pool, EXPIRED_RETENTION_SEC)
    const value = SANDBOX_TOKEN_PREFIX + randomBytes(TOKEN_BYTE_LENGTH).toString("base64url")
    const session = await SandboxSessionTokenRepository.insert(this.pool, {
      id: sandboxSessionTokenId(),
      workspaceId: params.workspaceId,
      tokenHash: hashToken(value),
      invokingUserId: params.invokingUserId,
      personaId: params.personaId,
      sessionId: params.sessionId,
      streamId: params.streamId,
      capturedStreamIds: [...new Set(params.capturedStreamIds)],
      ttlSec: params.ttlSec,
    })
    return { session, value }
  }

  /** Null for anything but a live, unrevoked token. */
  async validate(value: string): Promise<SandboxSession | null> {
    if (!value.startsWith(SANDBOX_TOKEN_PREFIX)) return null
    return SandboxSessionTokenRepository.findLiveByHash(this.pool, hashToken(value))
  }

  async revoke(workspaceId: string, id: string): Promise<void> {
    await SandboxSessionTokenRepository.revoke(this.pool, workspaceId, id)
  }

  async readableStreamIds(session: SandboxSession, filters: SearchFilters = {}): Promise<string[]> {
    const captured = new Set(session.capturedStreamIds)
    const userReadable = await resolveUserAccessibleStreamIds(
      this.pool,
      session.workspaceId,
      session.invokingUserId,
      filters
    )
    return this.withoutE2e(
      session.workspaceId,
      userReadable.filter((id) => captured.has(id))
    )
  }

  async isStreamReadable(session: SandboxSession, streamId: string): Promise<boolean> {
    if (!session.capturedStreamIds.includes(streamId)) return false
    const accessible = await listAccessibleStreamIds(this.pool, session.workspaceId, session.invokingUserId, [streamId])
    if (!accessible.has(streamId)) return false
    return (await this.withoutE2e(session.workspaceId, [streamId])).length === 1
  }

  private withoutE2e(workspaceId: string, streamIds: string[]): Promise<string[]> {
    return E2eStreamsRepository.excludeE2eRootedStreamIds(
      this.pool,
      streamIds.map((streamId) => ({ workspaceId, streamId }))
    )
  }
}
