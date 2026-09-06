import type { StreamType } from "@threahq/types"
import { StreamTypes } from "@threahq/types"
import type { Querier } from "../../db"
import { UserRepository } from "../workspaces"
import { StreamRepository } from "./repository"

export interface DmStreamSearchMatch {
  streamId: string
  displayName: string
  score: number
}

export async function searchDmStreamsByParticipant(params: {
  db: Querier
  workspaceId: string
  invokingUserId: string
  accessibleStreamIds: string[]
  query: string
  types?: StreamType[]
  limit: number
}): Promise<DmStreamSearchMatch[]> {
  const { db, workspaceId, invokingUserId, accessibleStreamIds, query, types, limit } = params
  const shouldSearchDms = !types || types.length === 0 || types.includes(StreamTypes.DM)
  if (!shouldSearchDms || accessibleStreamIds.length === 0) {
    return []
  }

  const dmPeers = await StreamRepository.listDmPeersForMember(db, workspaceId, invokingUserId, {
    streamIds: accessibleStreamIds,
  })
  if (dmPeers.length === 0) {
    return []
  }

  const peerIds = Array.from(new Set(dmPeers.map((peer) => peer.userId)))
  const peerUsers = await UserRepository.findByIds(db, workspaceId, peerIds)
  const peerById = new Map(peerUsers.map((user) => [user.id, user]))
  const queryTerms = extractSearchTerms(query)

  const matches: DmStreamSearchMatch[] = []
  for (const peer of dmPeers) {
    const peerUser = peerById.get(peer.userId)
    if (!peerUser) continue

    const score = scoreDmMatch({
      queryTerms,
      participantName: peerUser.name,
      participantSlug: peerUser.slug,
    })
    if (score === Number.POSITIVE_INFINITY) continue

    matches.push({
      streamId: peer.streamId,
      displayName: peerUser.name,
      score,
    })
  }

  return matches
    .sort((a, b) => {
      if (a.score !== b.score) return a.score - b.score
      return a.displayName.localeCompare(b.displayName)
    })
    .slice(0, limit)
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
