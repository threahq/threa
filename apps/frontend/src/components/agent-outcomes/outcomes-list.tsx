import { useEffect, useMemo, useRef } from "react"
import { Skeleton } from "@/components/ui/skeleton"
import { groupOutcomesByDay } from "@/lib/agent-outcomes/grouping"
import type { OutcomeItem } from "@/lib/agent-outcomes/items"
import { OutcomesEmpty } from "./outcomes-empty"
import { OutcomesRow } from "./outcomes-row"
import type { OutcomesFilters } from "./use-outcomes-url-state"

const NEXT_PAGE_PREFETCH_MARGIN = "200px"

interface OutcomesListProps {
  workspaceId: string
  items: OutcomeItem[]
  filters: OutcomesFilters
  hasFilters: boolean
  isLoading: boolean
  isError: boolean
  hasNextPage: boolean
  isFetchingNextPage: boolean
  fetchNextPage: () => void
  selectedId: string | null
  onSelect: (id: string) => void
  onClearFilters: () => void
  onWidenScope: () => void
}

export function OutcomesList({
  workspaceId,
  items,
  filters,
  hasFilters,
  isLoading,
  isError,
  hasNextPage,
  isFetchingNextPage,
  fetchNextPage,
  selectedId,
  onSelect,
  onClearFilters,
  onWidenScope,
}: OutcomesListProps) {
  const sentinelRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const node = sentinelRef.current
    if (!node) return
    if (!hasNextPage || isFetchingNextPage) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) fetchNextPage()
      },
      { rootMargin: NEXT_PAGE_PREFETCH_MARGIN }
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [hasNextPage, isFetchingNextPage, fetchNextPage])

  const groups = useMemo(() => groupOutcomesByDay(items), [items])

  if (isLoading && items.length === 0) {
    return (
      <div className="flex flex-col gap-0.5 px-2 pb-3 pt-1" data-testid="outcomes-skeleton">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3 rounded-item px-3 py-2">
            <Skeleton className="h-8 w-8 flex-none rounded-md" />
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <Skeleton className="h-3 w-1/2" />
              <Skeleton className="h-2.5 w-2/3" />
            </div>
          </div>
        ))}
      </div>
    )
  }

  if (isError) {
    return <OutcomesEmpty kind="error" filters={filters} />
  }

  if (items.length === 0) {
    return (
      <OutcomesEmpty
        kind={hasFilters ? "filtered-empty" : "empty"}
        filters={filters}
        onClearFilters={hasFilters ? onClearFilters : undefined}
        onWidenScope={filters.streamIds.length > 0 ? onWidenScope : undefined}
      />
    )
  }

  return (
    <div className="flex flex-col gap-2 px-2 pb-3 pt-1" role="list" data-testid="outcomes-list">
      {groups.map((group) => (
        <section key={group.key} aria-label={group.label}>
          <div className="sticky top-0 z-10 bg-background/95 px-3 pb-1 pt-2 text-xs font-medium text-muted-foreground backdrop-blur">
            {group.label}
          </div>
          <div className="flex flex-col gap-0.5" role="presentation">
            {group.items.map((item) => (
              <div key={item.id} role="listitem">
                <OutcomesRow
                  workspaceId={workspaceId}
                  item={item}
                  isSelected={selectedId === item.id}
                  onSelect={onSelect}
                />
              </div>
            ))}
          </div>
        </section>
      ))}
      <div ref={sentinelRef} aria-hidden className="h-4" />
      {isFetchingNextPage ? (
        <div className="flex items-center justify-center py-2 text-xs text-muted-foreground">Loading more…</div>
      ) : null}
    </div>
  )
}
