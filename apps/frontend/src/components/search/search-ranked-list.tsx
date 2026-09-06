import { useMemo } from "react"
import { useActors } from "@/hooks/use-actors"
import type { MemoExplorerResult, SearchCluster, SearchResultItem } from "@/api"
import { ClusterRow } from "./cluster-row"
import { useClusterExpansion } from "./use-cluster-expansion"
import { useSearchStreamLabels } from "./use-search-stream-labels"

interface SearchRankedListProps {
  workspaceId: string
  clusters: SearchCluster[]
  memos: MemoExplorerResult[]
  terms: string[]
  activeResultId: string | null
  /** `/w/<ws>/memory?q=<text>`; a memory chip opens `&memo=<id>` on it. */
  exploreHref: string
  onResultSelect: (result: SearchResultItem) => void
  onConversationSelect: (conversationId: string) => void
  onMemoSelect: (memoId: string) => void
  /** Phone widths fold every row's hits behind a count so the list fits on screen. */
  foldHits?: boolean
}

/** The Ranked view: every conversation row in rank order, each naming its stream. */
export function SearchRankedList({
  workspaceId,
  clusters,
  memos,
  terms,
  activeResultId,
  exploreHref,
  onResultSelect,
  onConversationSelect,
  onMemoSelect,
  foldHits = false,
}: SearchRankedListProps) {
  const { getActorName } = useActors(workspaceId)
  const streamIds = useMemo(() => clusters.map((cluster) => cluster.streamId), [clusters])
  const streamLabels = useSearchStreamLabels(workspaceId, streamIds)
  const memosById = useMemo(() => new Map(memos.map((memo) => [memo.memo.id, memo])), [memos])
  const expansion = useClusterExpansion(clusters, activeResultId)

  return (
    <ul className="flex flex-col gap-1.5">
      {clusters.map((cluster) => (
        <ClusterRow
          key={expansion.key(cluster)}
          workspaceId={workspaceId}
          cluster={cluster}
          memos={cluster.memoIds.flatMap((id) => memosById.get(id) ?? [])}
          terms={terms}
          activeResultId={activeResultId}
          exploreHref={exploreHref}
          streamLabels={streamLabels}
          getActorName={getActorName}
          showStreamLabel
          expanded={expansion.isExpanded(cluster)}
          onExpand={() => expansion.expand(cluster)}
          foldHits={foldHits}
          onResultSelect={onResultSelect}
          onConversationSelect={onConversationSelect}
          onMemoSelect={onMemoSelect}
        />
      ))}
    </ul>
  )
}
