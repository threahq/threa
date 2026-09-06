import type { SearchRefinement } from "@threahq/types"
import type { MemoExplorerResult, SearchCluster, SearchResultItem } from "@/api"
import type { SearchResultDisplayMode } from "@/lib/search-result-display-mode"
import { SearchGroupedList } from "./search-grouped-list"
import { SearchRankedList } from "./search-ranked-list"
import type { SearchStreamGroup } from "./group-clusters"

interface SearchResultListProps {
  workspaceId: string
  /** Which of the two views the display toggle has selected. */
  displayMode: SearchResultDisplayMode
  clusters: SearchCluster[]
  memos: MemoExplorerResult[]
  /** The same clusters grouped by stream, for the Grouped view. */
  groups: SearchStreamGroup[]
  terms: string[]
  activeResultId: string | null
  /** `/w/<ws>/memory?q=<text>`; a memory chip opens `&memo=<id>` on it. */
  exploreHref: string
  collapsedStreamIds: ReadonlySet<string>
  onToggleStream: (streamId: string) => void
  onResultSelect: (result: SearchResultItem) => void
  onConversationSelect: (conversationId: string) => void
  onMemoSelect: (memoId: string) => void
  /** Absent while refining is unavailable; the row menus then omit More like this / Drop. */
  onRefine?: (refine: SearchRefinement) => void
  /** Phone widths fold every row's hits behind a count so the list fits on screen. */
  foldHits?: boolean
}

/** The result list in the selected view, so both search surfaces choose it the same way. */
export function SearchResultList({
  workspaceId,
  displayMode,
  clusters,
  memos,
  groups,
  terms,
  activeResultId,
  exploreHref,
  collapsedStreamIds,
  onToggleStream,
  onResultSelect,
  onConversationSelect,
  onMemoSelect,
  onRefine,
  foldHits = false,
}: SearchResultListProps) {
  if (displayMode === "ranked") {
    return (
      <SearchRankedList
        workspaceId={workspaceId}
        clusters={clusters}
        memos={memos}
        terms={terms}
        activeResultId={activeResultId}
        exploreHref={exploreHref}
        foldHits={foldHits}
        onResultSelect={onResultSelect}
        onConversationSelect={onConversationSelect}
        onMemoSelect={onMemoSelect}
        onRefine={onRefine}
      />
    )
  }

  return (
    <SearchGroupedList
      workspaceId={workspaceId}
      groups={groups}
      terms={terms}
      activeResultId={activeResultId}
      exploreHref={exploreHref}
      collapsedStreamIds={collapsedStreamIds}
      onToggleStream={onToggleStream}
      foldHits={foldHits}
      onResultSelect={onResultSelect}
      onConversationSelect={onConversationSelect}
      onMemoSelect={onMemoSelect}
      onRefine={onRefine}
    />
  )
}
