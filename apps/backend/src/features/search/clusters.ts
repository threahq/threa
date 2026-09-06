import type { SearchClusterMatch } from "@threahq/types"
import type { MemoExplorerResult } from "../memos"
import type { ConversationForMessage, ConversationSearchResult, SearchResult } from "./repository"

/**
 * One row of the search list: a conversation with the messages that matched
 * inside it, or a lone message with no conversation. Memo hits attach to the
 * row their source messages belong to.
 */
export interface SearchCluster {
  conversation: ConversationForMessage | null
  streamId: string
  matchedVia: SearchClusterMatch[]
  hits: SearchResult[]
  memoIds: string[]
  score: number
}

export interface BuildSearchClustersInput {
  /** Message hits in ranked order. */
  results: SearchResult[]
  /** Conversations whose topic matched, nearest first. */
  conversations: ConversationSearchResult[]
  /** Memo hits in ranked order. */
  memos: MemoExplorerResult[]
  /** Primary conversation for every id in `results` and every memo source id, where one exists. */
  conversationByMessageId: Map<string, ConversationForMessage>
  /** Memo source messages that are not in `results`, in posting order. */
  sourceMessages: SearchResult[]
  /** Reciprocal-rank constant: score = Σ 1/(k + position) over every list a row appears in. */
  k: number
}

/**
 * Folds the three ranked lists into one list of rows. A row's score is the
 * reciprocal-rank sum of everything that landed on it, so a conversation
 * with several matching messages outranks a single stray hit at the top.
 * A memo lands on the row its first anchored source message belongs to; a
 * memo with no anchored source becomes its own row, carrying its source
 * messages so the user can reach them without going through the explorer.
 */
export function buildSearchClusters(input: BuildSearchClustersInput): SearchCluster[] {
  const { results, conversations, memos, conversationByMessageId, sourceMessages, k } = input
  const clusters = new Map<string, SearchCluster>()
  const resultById = new Map(results.map((result) => [result.id, result]))
  const sourceById = new Map(sourceMessages.map((message) => [message.id, message]))

  function ensure(key: string, seed: () => Omit<SearchCluster, "matchedVia" | "hits" | "memoIds" | "score">) {
    let cluster = clusters.get(key)
    if (!cluster) {
      cluster = { ...seed(), matchedVia: [], hits: [], memoIds: [], score: 0 }
      clusters.set(key, cluster)
    }
    return cluster
  }

  function land(cluster: SearchCluster, via: SearchClusterMatch, position: number) {
    if (!cluster.matchedVia.includes(via)) cluster.matchedVia.push(via)
    cluster.score += 1 / (k + position)
  }

  function keyForMessage(messageId: string): { key: string; conversation: ConversationForMessage | null } {
    const conversation = conversationByMessageId.get(messageId) ?? null
    return conversation
      ? { key: `conversation:${conversation.id}`, conversation }
      : { key: `message:${messageId}`, conversation: null }
  }

  results.forEach((result, index) => {
    const { key, conversation } = keyForMessage(result.id)
    const cluster = ensure(key, () => ({ conversation, streamId: conversation?.streamId ?? result.streamId }))
    cluster.hits.push(result)
    land(cluster, "message", index + 1)
  })

  conversations.forEach((conversation, index) => {
    const { distance: _distance, ...row } = conversation
    const cluster = ensure(`conversation:${conversation.id}`, () => ({ conversation: row, streamId: row.streamId }))
    land(cluster, "topic", index + 1)
  })

  memos.forEach((memoResult, index) => {
    const { memo } = memoResult
    const anchor = memo.sourceMessageIds.find((id) => conversationByMessageId.has(id) || resultById.has(id))
    let cluster: SearchCluster | null = null
    if (anchor) {
      const { key, conversation } = keyForMessage(anchor)
      const streamId = conversation?.streamId ?? resultById.get(anchor)?.streamId ?? sourceById.get(anchor)?.streamId
      if (!streamId) return
      cluster = ensure(key, () => ({ conversation, streamId }))
    } else {
      const sources = memo.sourceMessageIds.map((id) => sourceById.get(id)).filter((m): m is SearchResult => m != null)
      const streamId = sources[0]?.streamId ?? memoResult.sourceStream?.id
      if (!streamId) return
      cluster = ensure(`memo:${memo.id}`, () => ({ conversation: null, streamId }))
    }
    if (cluster.hits.length === 0) {
      const wanted = new Set(memo.sourceMessageIds)
      cluster.hits.push(...sourceMessages.filter((message) => wanted.has(message.id)))
    }
    cluster.memoIds.push(memo.id)
    land(cluster, "memory", index + 1)
  })

  return [...clusters.values()].sort((a, b) => b.score - a.score || latestAt(b) - latestAt(a))
}

/** Newest activity in a row (hit or conversation), 0 when nothing carries a date. */
export function latestAt(cluster: SearchCluster): number {
  const fromHits = cluster.hits.reduce((max, hit) => Math.max(max, hit.createdAt.getTime()), 0)
  return Math.max(fromHits, cluster.conversation?.lastMessageAt?.getTime() ?? 0)
}
