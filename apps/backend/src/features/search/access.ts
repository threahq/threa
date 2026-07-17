import type { Querier } from "../../db"
import { StreamRepository } from "../streams"
import { SearchRepository } from "./repository"
import type { SearchFilters } from "./service"

/**
 * Resolve accessible stream IDs for a user session.
 * Extracted from SearchService so callers can resolve access
 * before passing to the auth-agnostic SearchService.search().
 */
/**
 * Resolve the `in:` filter's mixed entries to concrete stream IDs.
 *
 * Entries are either stream IDs (in:#channel) or user IDs (in:@user, meaning
 * the requester's DM with that user). Resolved streams expand to include their
 * thread descendants so "in this conversation" covers replies. A user with no
 * DM resolves to nothing — the caller must treat an empty result as "no
 * matches", not as an absent filter.
 */
export async function resolveInFilterStreamIds(
  db: Querier,
  workspaceId: string,
  userId: string,
  inIds: string[]
): Promise<string[]> {
  const streamIds = inIds.filter((id) => !id.startsWith("usr_"))
  const dmUserIds = inIds.filter((id) => id.startsWith("usr_"))

  if (dmUserIds.length > 0) {
    const dmPeers = await StreamRepository.listDmPeersForMember(db, workspaceId, userId)
    const streamIdByPeer = new Map(dmPeers.map((peer) => [peer.userId, peer.streamId]))
    for (const dmUserId of dmUserIds) {
      const dmStreamId = streamIdByPeer.get(dmUserId)
      if (dmStreamId) streamIds.push(dmStreamId)
    }
  }

  return SearchRepository.expandStreamIdsWithThreads(db, workspaceId, streamIds)
}

export async function resolveUserAccessibleStreamIds(
  db: Querier,
  workspaceId: string,
  userId: string,
  filters: SearchFilters
): Promise<string[]> {
  return SearchRepository.getAccessibleStreamsWithMembers(db, {
    workspaceId,
    userId,
    userIds: filters.userIds,
    streamTypes: filters.streamTypes,
    archiveStatus: filters.archiveStatus,
  })
}
