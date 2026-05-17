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

    return [...new Set([...publicStreamIds, ...grantedStreamIds])]
  }

  async isStreamAccessibleForBot(workspaceId: string, botId: string, streamId: string): Promise<boolean> {
    const stream = await StreamRepository.findById(this.pool, streamId)
    if (!stream || stream.workspaceId !== workspaceId) return false

    // Check public first (fast path)
    if (stream.visibility === "public") return true

    const grantStreamId = stream.type === StreamTypes.THREAD && stream.rootStreamId ? stream.rootStreamId : stream.id

    // Point query for explicit grant (single EXISTS, no full scan)
    return BotChannelAccessRepository.hasGrant(this.pool, workspaceId, botId, grantStreamId)
  }

  async getPublicStreamIds(workspaceId: string): Promise<string[]> {
    return SearchRepository.getPublicStreams(this.pool, workspaceId)
  }
}
