import type { Pool } from "pg"
import { StreamTypes } from "@threa/types"
import { BotChannelAccessRepository } from "./repository"
import { SearchRepository, resolveUserAccessibleStreamIds } from "../search"
import { StreamRepository, resolveEffectiveAccessStream, checkStreamAccess } from "../streams"
import { E2eStreamsRepository } from "../e2e-streams"

interface BotChannelServiceDeps {
  pool: Pool
}

export class BotChannelService {
  private pool: Pool

  constructor(deps: BotChannelServiceDeps) {
    this.pool = deps.pool
  }

  async getAccessibleStreamIdsForBot(workspaceId: string, botId: string): Promise<string[]> {
    const readAsOwnerId = await BotChannelAccessRepository.getReadAsOwnerDelegate(this.pool, workspaceId, botId)
    const [publicStreamIds, grantedStreamIds, ownerStreamIds] = await Promise.all([
      SearchRepository.getPublicStreams(this.pool, workspaceId),
      BotChannelAccessRepository.getGrantedStreamIds(this.pool, workspaceId, botId),
      readAsOwnerId ? this.getOwnerReadableStreamIds(workspaceId, readAsOwnerId) : [],
    ])

    // A grant on a private channel must cover its threads (INV-62): they
    // inherit the root's private visibility, so getPublicStreams never
    // includes them. isStreamAccessibleForBot already maps thread -> root;
    // this keeps the list-shaped scope consistent with that point check.
    const grantedWithThreads =
      grantedStreamIds.length > 0
        ? await SearchRepository.expandStreamIdsWithThreads(this.pool, workspaceId, grantedStreamIds)
        : []

    return [...new Set([...publicStreamIds, ...grantedWithThreads, ...ownerStreamIds])]
  }

  /**
   * The read-as-owner arm: everything the delegating owner can read (the
   * canonical INV-62 predicate, threads included), minus E2E-rooted streams —
   * read-as-owner never shortcuts the grant + key-wrap path an E2E stream
   * requires. Active-only, matching the public and grant arms; evaluated per
   * call, so the owner losing access revokes the bot's in the same moment.
   */
  private async getOwnerReadableStreamIds(workspaceId: string, ownerUserId: string): Promise<string[]> {
    const ownerIds = await resolveUserAccessibleStreamIds(this.pool, workspaceId, ownerUserId, {})
    return E2eStreamsRepository.excludeE2eRootedStreamIds(this.pool, workspaceId, ownerIds)
  }

  async isStreamAccessibleForBot(workspaceId: string, botId: string, streamId: string): Promise<boolean> {
    const stream = await StreamRepository.findByIdForWorkspace(this.pool, streamId, workspaceId)
    if (!stream || stream.archivedAt) return false

    // Publicness is the ROOT's visibility (INV-62) — a thread's own row can
    // hold a stale copied "public" long after its root went private. A
    // dangling root (INV-1, FK-less) resolves back to the thread itself:
    // fail closed to the grant check, never the stale copied value.
    const effective = await resolveEffectiveAccessStream(this.pool, stream)
    const rootResolved = !stream.rootStreamId || effective.id === stream.rootStreamId
    if (rootResolved && effective.visibility === "public") return true

    const grantStreamId = stream.type === StreamTypes.THREAD && stream.rootStreamId ? stream.rootStreamId : stream.id

    // Point query for explicit grant (single EXISTS, no full scan)
    if (await BotChannelAccessRepository.hasGrant(this.pool, workspaceId, botId, grantStreamId)) return true

    return this.isReadableAsOwner(workspaceId, botId, streamId)
  }

  /**
   * Point-check form of the read-as-owner arm: delegate to the canonical
   * per-id predicate with the owner's identity, then apply the same E2E
   * exclusion as {@link getOwnerReadableStreamIds}. The archived denial above
   * covers this arm too — an archived stream never reaches here.
   */
  private async isReadableAsOwner(workspaceId: string, botId: string, streamId: string): Promise<boolean> {
    const readAsOwnerId = await BotChannelAccessRepository.getReadAsOwnerDelegate(this.pool, workspaceId, botId)
    if (!readAsOwnerId) return false
    const readable = await checkStreamAccess(this.pool, streamId, workspaceId, readAsOwnerId)
    if (!readable) return false
    return !(await E2eStreamsRepository.isE2eStream(this.pool, workspaceId, readable.rootStreamId ?? readable.id))
  }

  async getPublicStreamIds(workspaceId: string): Promise<string[]> {
    return SearchRepository.getPublicStreams(this.pool, workspaceId)
  }
}
