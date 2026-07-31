import type { Pool } from "pg"
import { StreamTypes } from "@threa/types"
import { BotChannelAccessRepository } from "./repository"
import { SearchRepository } from "../search"
import { StreamRepository } from "../streams"

interface BotChannelServiceDeps {
  pool: Pool
}

export class BotChannelService {
  private pool: Pool

  constructor(deps: BotChannelServiceDeps) {
    this.pool = deps.pool
  }

  async getAccessibleStreamIdsForBot(workspaceId: string, botId: string): Promise<string[]> {
    const [publicStreamIds, grantedStreamIds] = await Promise.all([
      SearchRepository.getPublicStreams(this.pool, workspaceId),
      BotChannelAccessRepository.getGrantedStreamIds(this.pool, workspaceId, botId),
    ])

    // A grant on a private channel must cover its threads (INV-62): they
    // inherit the root's private visibility, so getPublicStreams never
    // includes them. isStreamAccessibleForBot already maps thread -> root;
    // this keeps the list-shaped scope consistent with that point check.
    const grantedWithThreads =
      grantedStreamIds.length > 0
        ? await SearchRepository.expandStreamIdsWithThreads(this.pool, workspaceId, grantedStreamIds)
        : []

    return [...new Set([...publicStreamIds, ...grantedWithThreads])]
  }

  async isStreamAccessibleForBot(workspaceId: string, botId: string, streamId: string): Promise<boolean> {
    const stream = await StreamRepository.findByIdForWorkspace(this.pool, streamId, workspaceId)
    if (!stream || stream.archivedAt) return false

    // Publicness is the ROOT's visibility (INV-62) — a thread's own row can
    // hold a stale copied "public" long after its root went private.
    const accessStream = stream.rootStreamId
      ? await StreamRepository.findByIdForWorkspace(this.pool, stream.rootStreamId, workspaceId)
      : stream
    if (accessStream?.visibility === "public") return true

    const grantStreamId = stream.type === StreamTypes.THREAD && stream.rootStreamId ? stream.rootStreamId : stream.id

    // Point query for explicit grant (single EXISTS, no full scan)
    return BotChannelAccessRepository.hasGrant(this.pool, workspaceId, botId, grantStreamId)
  }

  async getPublicStreamIds(workspaceId: string): Promise<string[]> {
    return SearchRepository.getPublicStreams(this.pool, workspaceId)
  }
}
