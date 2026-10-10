import type { StreamType } from "@threahq/types"
import { StreamTypes } from "@threahq/types"
import type { Querier } from "../../db"
import type { ArchiveStatus } from "../../lib/sql-filters"
import { UserRepository, type User } from "../workspaces"
import { StreamRepository } from "./repository"

export interface DmStreamSearchMatch {
  streamId: string
  displayName: string
  score: number
}

async function listDmPeerUsers(params: {
  db: Querier
  workspaceId: string
  invokingUserId: string
  streamIds: string[]
  archiveStatus: ArchiveStatus[]
}): Promise<Array<{ streamId: string; user: User }>> {
  const { db, workspaceId, invokingUserId, streamIds, archiveStatus } = params
  if (streamIds.length === 0) return []

  const dmPeers = await StreamRepository.listDmPeersForMember(db, workspaceId, invokingUserId, {
    streamIds,
    archiveStatus,
  })
  const peerUsers = await UserRepository.findByIds(db, workspaceId, Array.from(new Set(dmPeers.map((p) => p.userId))))
  const userById = new Map(peerUsers.map((user) => [user.id, user]))

  return dmPeers.flatMap((peer) => {
    const user = userById.get(peer.userId)
    return user ? [{ streamId: peer.streamId, user }] : []
  })
}

export async function searchDmStreamsByParticipant(params: {
  db: Querier
  workspaceId: string
  invokingUserId: string
  accessibleStreamIds: string[]
  query: string
  types?: StreamType[]
  archiveStatus: ArchiveStatus[]
  limit: number
}): Promise<DmStreamSearchMatch[]> {
  const { db, workspaceId, invokingUserId, accessibleStreamIds, query, types, archiveStatus, limit } = params
  const shouldSearchDms = !types || types.length === 0 || types.includes(StreamTypes.DM)
  if (!shouldSearchDms) {
    return []
  }

  const peers = await listDmPeerUsers({
    db,
    workspaceId,
    invokingUserId,
    streamIds: accessibleStreamIds,
    archiveStatus,
  })
  const queryTerms = extractSearchTerms(query)

  const matches: DmStreamSearchMatch[] = []
  for (const { streamId, user } of peers) {
    const score = scoreDmMatch({
      queryTerms,
      participantName: user.name,
      participantSlug: user.slug,
    })
    if (score === Number.POSITIVE_INFINITY) continue

    matches.push({ streamId, displayName: user.name, score })
  }

  return matches
    .sort((a, b) => {
      if (a.score !== b.score) return a.score - b.score
      return a.displayName.localeCompare(b.displayName)
    })
    .slice(0, limit)
}

export async function listDmDisplayNames(params: {
  db: Querier
  workspaceId: string
  invokingUserId: string
  streamIds: string[]
}): Promise<Map<string, string>> {
  const peers = await listDmPeerUsers({ ...params, archiveStatus: ["active", "archived"] })
  return new Map(peers.map((p) => [p.streamId, p.user.name]))
}

function extractSearchTerms(query: string): string[] {
  const lowerQuery = query.trim().toLowerCase()
  if (!lowerQuery) return []

  const terms = new Set<string>([lowerQuery])
  if (lowerQuery.startsWith("@")) {
    terms.add(lowerQuery.slice(1))
  }

  const tokenMatches = lowerQuery.match(/[@]?[\p{L}\p{N}][\p{L}\p{N}-]*/gu) ?? []
  for (const token of tokenMatches) {
    terms.add(token)
    if (token.startsWith("@")) {
      terms.add(token.slice(1))
    }
  }

  return Array.from(terms).filter((term) => term.length > 1)
}

function scoreDmMatch(params: { queryTerms: string[]; participantName: string; participantSlug: string }): number {
  const candidates = [
    params.participantName.toLowerCase(),
    params.participantSlug.toLowerCase(),
    `@${params.participantSlug.toLowerCase()}`,
  ]

  let bestScore = Number.POSITIVE_INFINITY
  for (const candidate of candidates) {
    for (const term of params.queryTerms) {
      if (candidate === term) {
        bestScore = Math.min(bestScore, 0)
      } else if (candidate.startsWith(term)) {
        bestScore = Math.min(bestScore, 1)
      } else if (candidate.includes(term)) {
        bestScore = Math.min(bestScore, 2)
      }
    }
  }

  return bestScore
}
