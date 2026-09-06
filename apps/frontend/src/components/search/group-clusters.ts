import type { MemoExplorerResult, SearchCluster } from "@/api"

export interface SearchStreamGroup {
  streamId: string
  clusters: SearchCluster[]
  /** The memos this stream's clusters point at, first reference first. */
  memos: MemoExplorerResult[]
}

/** What the "N results" summary counts: every hit, and a hit-less topic row as one. */
export function countClusterResults(clusters: readonly SearchCluster[]): number {
  return clusters.reduce((count, cluster) => count + Math.max(cluster.hits.length, 1), 0)
}

/**
 * One group per stream for the grouped view: groups in the rank order of their
 * best cluster, clusters in rank order inside, and the memos their rows point
 * at gathered on the group so the chips can sit after its last row.
 */
export function groupClustersByStream(
  clusters: readonly SearchCluster[],
  memos: readonly MemoExplorerResult[]
): SearchStreamGroup[] {
  const memosById = new Map(memos.map((memo) => [memo.memo.id, memo]))
  const groups = new Map<string, SearchStreamGroup>()
  const groupMemoIds = new Map<string, Set<string>>()

  for (const cluster of clusters) {
    let group = groups.get(cluster.streamId)
    if (!group) {
      group = { streamId: cluster.streamId, clusters: [], memos: [] }
      groups.set(cluster.streamId, group)
      groupMemoIds.set(cluster.streamId, new Set())
    }
    const seen = groupMemoIds.get(cluster.streamId)!
    group.clusters.push(cluster)
    for (const memoId of cluster.memoIds) {
      const memo = memosById.get(memoId)
      if (!memo || seen.has(memoId)) continue
      seen.add(memoId)
      group.memos.push(memo)
    }
  }

  return Array.from(groups.values())
}
