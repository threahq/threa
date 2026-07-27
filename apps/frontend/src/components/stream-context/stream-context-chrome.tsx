import { useSearchParams } from "react-router-dom"
import { PanelRight, Sparkles } from "lucide-react"
import { SidePanelClose, SidePanelHeader, SidePanelTitle } from "@/components/ui/side-panel"
import { Skeleton } from "@/components/ui/skeleton"
import { StreamContextList } from "./stream-context-list"
import { groupItemsByDay } from "@/lib/stream-context/grouping"
import { CONTEXT_CATEGORIES, type ContextCategory, type ContextItem } from "@/lib/stream-context/types"
import { cn } from "@/lib/utils"

export type Filter = "all" | ContextCategory

/** The props both panel implementations take; `StreamContextPanel` picks one. */
export interface StreamContextPanelProps {
  workspaceId: string
  streamId: string
  onClose: () => void
  onJumpToMessage: (messageId: string) => void
  onOpenThread: (threadId: string) => void
  onOpenMemo: (memoId: string) => void
  onOpenGallery: (key: string) => void
}

export const CATEGORY_LABELS: Record<ContextCategory, string> = {
  link: "Links",
  media: "Media",
  file: "Files",
  memo: "Memories",
  delegation: "Delegations",
  thread: "Threads",
}

export function parseFilter(raw: string | null): Filter {
  if (raw === "all") return "all"
  if (raw && (CONTEXT_CATEGORIES as string[]).includes(raw)) return raw as ContextCategory
  return "all"
}

/**
 * The active category filter, held in the URL (`?context=` doubles as the
 * open-state and the selected category), so a refresh or shared link lands on
 * the same view (INV-59). Changing it replaces history — view chrome, not
 * navigation.
 */
export function useContextFilter(): [Filter, (value: Filter) => void] {
  const [searchParams, setSearchParams] = useSearchParams()
  const filter = parseFilter(searchParams.get("context"))
  const setFilter = (value: Filter) => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        next.set("context", value)
        return next
      },
      { replace: true }
    )
  }
  return [filter, setFilter]
}

export interface ContextChip {
  value: Filter
  label: string
  count: number
}

/** Build the chip row from per-category counts, dropping empty categories. */
export function chipsFromCounts(counts: Record<ContextCategory, number>, total: number): ContextChip[] {
  return [
    { value: "all", label: "All", count: total },
    ...CONTEXT_CATEGORIES.filter((c) => counts[c] > 0).map((c) => ({
      value: c as Filter,
      label: CATEGORY_LABELS[c],
      count: counts[c],
    })),
  ]
}

export function ContextChipRow({
  chips,
  active,
  onSelect,
}: {
  chips: ContextChip[]
  active: Filter
  onSelect: (value: Filter) => void
}) {
  return (
    <div className="flex shrink-0 items-center gap-1.5 overflow-x-auto border-b px-3 py-2 [-webkit-mask-image:linear-gradient(to_right,#000_calc(100%_-_20px),transparent)] [mask-image:linear-gradient(to_right,#000_calc(100%_-_20px),transparent)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {chips.map((chip) => {
        const isActive = active === chip.value
        return (
          <button
            key={chip.value}
            type="button"
            aria-pressed={isActive}
            onClick={() => onSelect(chip.value)}
            className={cn(
              "shrink-0 rounded-full px-2.5 py-1 text-xs font-medium transition-colors",
              isActive
                ? "bg-foreground text-background"
                : "bg-muted text-muted-foreground hover:bg-accent hover:text-foreground"
            )}
          >
            {chip.label}
            <span className={cn("ml-1 tabular-nums", isActive ? "opacity-80" : "opacity-60")}>{chip.count}</span>
          </button>
        )
      })}
    </div>
  )
}

export function ContextPanelHeader({ total, onClose }: { total: number; onClose: () => void }) {
  return (
    <SidePanelHeader className="gap-2">
      <div className="flex min-w-0 items-center gap-2">
        <PanelRight className="size-4 shrink-0 text-muted-foreground" />
        <SidePanelTitle className="text-sm">In this stream</SidePanelTitle>
        {total > 0 && (
          <span className="shrink-0 rounded-full bg-muted px-1.5 text-[11px] font-medium tabular-nums text-muted-foreground">
            {total}
          </span>
        )}
      </div>
      <SidePanelClose onClose={onClose} />
    </SidePanelHeader>
  )
}

export function ContextSkeleton() {
  return (
    <div className="flex flex-col gap-2 p-1">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="flex items-center gap-3 px-2 py-2">
          <Skeleton className="size-10 shrink-0 rounded-md" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-3.5 w-2/3" />
            <Skeleton className="h-3 w-1/3" />
          </div>
        </div>
      ))}
    </div>
  )
}

export function ContextEmpty({ message }: { message?: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 text-center">
      <div className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Sparkles className="size-5" />
      </div>
      <p className="mt-3 text-sm font-medium">Nothing here yet</p>
      <p className="mt-1 max-w-[16rem] text-xs text-muted-foreground">
        {message ??
          "Links, files, images, captured memories and delegated tasks from this conversation collect here automatically."}
      </p>
    </div>
  )
}

/** A gold milestone dot + date label seated on the timeline spine. */
export function TimelineDayMarker({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 py-1">
      <div className="flex w-12 shrink-0 justify-center">
        <span className="size-2.5 rounded-full bg-primary/80 ring-4 ring-background" />
      </div>
      <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</span>
    </div>
  )
}

/**
 * The day-grouped timeline body. `renderItem` lets a caller decorate a row
 * (the index panel wraps multi-occurrence rows in an expander) without the row
 * component knowing about either path.
 */
export function ContextTimeline({
  items,
  renderItem,
  footer,
  scrollRef,
}: {
  items: ContextItem[]
  renderItem: (item: ContextItem) => React.ReactNode
  footer?: React.ReactNode
  /** The panel's scroller. Given one, rows are windowed; without one they all mount. */
  scrollRef?: React.RefObject<HTMLDivElement | null>
}) {
  // Flattened, not nested per day: virtua windows a flat child list, so a day
  // marker is a row of its own rather than a wrapper around its group. Keyed on
  // a stable item id — date labels repeat across years and would collide.
  const rows = groupItemsByDay(items, new Date()).flatMap((group) => [
    <div key={`day:${group.items[0].key}`} className="pt-3 first:pt-0">
      <TimelineDayMarker label={group.label} />
    </div>,
    ...group.items.map((item) => <div key={item.key}>{renderItem(item)}</div>),
  ])

  return (
    <div className="relative pb-2">
      {/* the spine — one continuous line behind every node; a hint of gold at
          its origin (the golden thread) fading down. Outside the virtualizer:
          it spans the whole list, not any one windowed row. */}
      <div
        aria-hidden
        className="absolute bottom-3 left-6 top-3 w-px bg-gradient-to-b from-primary/40 via-border to-border"
      />
      {scrollRef ? <StreamContextList scrollRef={scrollRef}>{rows}</StreamContextList> : rows}
      {footer}
    </div>
  )
}
