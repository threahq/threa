import { useMemo } from "react"
import { Archive, ChevronDown, ChevronRight, Loader2 } from "lucide-react"
import type { SearchRefinement } from "@threahq/types"
import { useActors } from "@/hooks/use-actors"
import { cn } from "@/lib/utils"
import type { SearchResultItem } from "@/api"
import { ClusterRow, MemoChip } from "./cluster-row"
import { countClusterResults, type SearchStreamGroup } from "./group-clusters"
import { useClusterExpansion } from "./use-cluster-expansion"
import { useSearchStreamLabels } from "./use-search-stream-labels"

interface SearchGroupedListProps {
  workspaceId: string
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

/** The Grouped view: a collapsible stream header per stream, its rows nested under it. */
export function SearchGroupedList({
  workspaceId,
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
}: SearchGroupedListProps) {
  const { getActorName } = useActors(workspaceId)
  const streamIds = useMemo(() => groups.map((group) => group.streamId), [groups])
  const streamLabels = useSearchStreamLabels(workspaceId, streamIds)
  const clusters = useMemo(() => groups.flatMap((group) => group.clusters), [groups])
  const expansion = useClusterExpansion(clusters, activeResultId)

  return (
    <div className="flex flex-col gap-1">
      {groups.map((group) => {
        const collapsed = collapsedStreamIds.has(group.streamId)
        const archived = streamLabels.isArchived(group.streamId)
        return (
          <section key={group.streamId} data-search-group={group.streamId}>
            <button
              type="button"
              onClick={() => onToggleStream(group.streamId)}
              aria-expanded={!collapsed}
              className={cn(
                "flex w-full min-w-0 items-center gap-1 rounded-md px-1.5 py-1 text-left text-xs font-semibold transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                archived ? "text-muted-foreground" : "text-foreground/90"
              )}
            >
              {collapsed ? (
                <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground/70" aria-hidden="true" />
              ) : (
                <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground/70" aria-hidden="true" />
              )}
              {streamLabels.isResolving(group.streamId) ? (
                <Loader2 className="h-3 w-3 shrink-0 animate-spin" aria-label="Loading stream" />
              ) : (
                <span className="min-w-0 truncate" data-search-stream-label={group.streamId}>
                  {streamLabels.label(group.streamId)}
                </span>
              )}
              <span className="h-3 w-3 shrink-0">
                {archived && <Archive className="h-3 w-3 text-foreground" aria-label="Archived stream" role="img" />}
              </span>
              <span className="ml-auto shrink-0 rounded-full bg-muted px-1.5 py-px text-[10px] font-medium tabular-nums text-muted-foreground">
                {countClusterResults(group.clusters)}
              </span>
            </button>

            {!collapsed && (
              <ul className="mb-1 ml-2 flex flex-col gap-1.5">
                {group.clusters.map((cluster) => (
                  <ClusterRow
                    key={expansion.key(cluster)}
                    workspaceId={workspaceId}
                    cluster={cluster}
                    memos={[]}
                    terms={terms}
                    activeResultId={activeResultId}
                    exploreHref={exploreHref}
                    streamLabels={streamLabels}
                    getActorName={getActorName}
                    showStreamLabel={false}
                    expanded={expansion.isExpanded(cluster)}
                    onExpand={() => expansion.expand(cluster)}
                    foldHits={foldHits}
                    onResultSelect={onResultSelect}
                    onConversationSelect={onConversationSelect}
                    onMemoSelect={onMemoSelect}
                    onRefine={onRefine}
                  />
                ))}
                {group.memos.length > 0 && (
                  <li className="flex flex-wrap items-center gap-1 pl-1">
                    {group.memos.map((memo) => (
                      <MemoChip key={memo.memo.id} result={memo} exploreHref={exploreHref} onSelect={onMemoSelect} />
                    ))}
                  </li>
                )}
              </ul>
            )}
          </section>
        )
      })}
    </div>
  )
}
