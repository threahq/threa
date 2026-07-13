import { useEffect, useMemo, useRef } from "react"
import type { AttachmentSearchItem } from "@/api/attachments"
import { Skeleton } from "@/components/ui/skeleton"
import { ExplorerRow } from "./explorer-row"
import { ExplorerEmpty } from "./explorer-empty"

const NEXT_PAGE_PREFETCH_MARGIN = "200px"

interface ExplorerListProps {
  workspaceId: string
  items: AttachmentSearchItem[]
  isLoading: boolean
  isError: boolean
  hasNextPage: boolean
  isFetchingNextPage: boolean
  fetchNextPage: () => void
  selectedId: string | null
  onSelect: (id: string) => void
  /** Picker override forwarded to each {@link ExplorerRow}; see its prop doc. */
  onSelectAttachment?: (item: AttachmentSearchItem) => void
  onClearFilters?: () => void
  onWidenScope?: () => void
  hasFilters: boolean
}

interface DayBucket {
  label: string
  items: AttachmentSearchItem[]
}

function bucketByDay(items: AttachmentSearchItem[], dayLabel: (date: Date) => string): DayBucket[] {
  const buckets: DayBucket[] = []
  let currentLabel: string | null = null
  for (const item of items) {
    const label = dayLabel(new Date(item.createdAt))
    if (label !== currentLabel) {
      buckets.push({ label, items: [] })
      currentLabel = label
    }
    buckets[buckets.length - 1]!.items.push(item)
  }
  return buckets
}

function relativeDayLabel(date: Date, now = new Date()): string {
  const startOf = (d: Date) => {
    const x = new Date(d)
    x.setHours(0, 0, 0, 0)
    return x
  }
  const diffDays = Math.floor((startOf(now).getTime() - startOf(date).getTime()) / 86_400_000)
  if (diffDays <= 0) return "Today"
  if (diffDays === 1) return "Yesterday"
  if (diffDays <= 6) return "This week"
  if (diffDays <= 30) return "This month"
  if (date.getFullYear() === now.getFullYear()) return "Earlier this year"
  return "Older"
}

export function ExplorerList({
  workspaceId,
  items,
  isLoading,
  isError,
  hasNextPage,
  isFetchingNextPage,
  fetchNextPage,
  selectedId,
  onSelect,
  onSelectAttachment,
  onClearFilters,
  onWidenScope,
  hasFilters,
}: ExplorerListProps) {
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

  const buckets = useMemo(() => bucketByDay(items, (d) => relativeDayLabel(d)), [items])

  if (isLoading && items.length === 0) {
    return (
      <div className="flex flex-col gap-0.5 px-2 pt-1 pb-3" data-testid="explorer-skeleton">
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
    return <ExplorerEmpty kind="error" />
  }

  if (items.length === 0) {
    return (
      <ExplorerEmpty
        kind={hasFilters ? "filtered-empty" : "empty"}
        onClearFilters={onClearFilters}
        onWidenScope={onWidenScope}
      />
    )
  }

  return (
    <div className="flex flex-col gap-2 px-2 pb-3 pt-1" role="list">
      {buckets.map((bucket) => (
        <section key={bucket.label} aria-label={bucket.label}>
          <div className="px-3 pb-1 pt-2 text-xs font-medium text-muted-foreground">{bucket.label}</div>
          <div className="flex flex-col gap-0.5" role="presentation">
            {bucket.items.map((item) => (
              <div key={item.id} role="listitem" data-attachment-id={item.id}>
                <ExplorerRow
                  workspaceId={workspaceId}
                  item={item}
                  isSelected={selectedId === item.id}
                  onSelect={onSelect}
                  onSelectAttachment={onSelectAttachment}
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
