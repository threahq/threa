import { useMemo, useState } from "react"
import { PanelRight, Sparkles } from "lucide-react"
import { SidePanelClose, SidePanelHeader, SidePanelTitle } from "@/components/ui/side-panel"
import { Skeleton } from "@/components/ui/skeleton"
import { useStreamEvents } from "@/stores/stream-store"
import { deriveStreamContext } from "@/lib/stream-context/derive"
import { groupItemsByDay } from "@/lib/stream-context/grouping"
import { CONTEXT_CATEGORIES, type ContextCategory } from "@/lib/stream-context/types"
import { cn } from "@/lib/utils"
import { StreamContextRow } from "./stream-context-row"

type Filter = "all" | ContextCategory

const CATEGORY_LABELS: Record<ContextCategory, string> = {
  link: "Links",
  media: "Media",
  file: "Files",
  memo: "Memories",
  thread: "Threads",
}

/** A gold milestone dot + date label seated on the timeline spine. */
function TimelineDayMarker({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 py-1">
      <div className="flex w-12 shrink-0 justify-center">
        <span className="size-2.5 rounded-full bg-primary/80 ring-4 ring-background" />
      </div>
      <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</span>
    </div>
  )
}

interface StreamContextPanelProps {
  workspaceId: string
  streamId: string
  onClose: () => void
  onJumpToMessage: (messageId: string) => void
  onOpenThread: (threadId: string) => void
  onOpenMemo: (memoId: string) => void
}

export function StreamContextPanel({
  workspaceId,
  streamId,
  onClose,
  onJumpToMessage,
  onOpenThread,
  onOpenMemo,
}: StreamContextPanelProps) {
  const events = useStreamEvents(streamId)
  const isLoading = events === undefined
  const { items, counts, total } = useMemo(() => deriveStreamContext(events), [events])
  const [filter, setFilter] = useState<Filter>("all")

  // A previously-selected filter can empty out as the live event set changes
  // (e.g. a thread's last reply scrolls out of the loaded window); fall back to
  // "all" so the body never strands the user on an empty filter.
  const effectiveFilter: Filter = filter !== "all" && counts[filter] === 0 ? "all" : filter
  const visible = effectiveFilter === "all" ? items : items.filter((i) => i.category === effectiveFilter)

  const chips: Array<{ value: Filter; label: string; count: number }> = [
    { value: "all", label: "All", count: total },
    ...CONTEXT_CATEGORIES.filter((c) => counts[c] > 0).map((c) => ({
      value: c,
      label: CATEGORY_LABELS[c],
      count: counts[c],
    })),
  ]

  let body: React.ReactNode
  if (isLoading) {
    body = (
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
  } else if (visible.length === 0) {
    body = (
      <div className="flex h-full flex-col items-center justify-center px-6 text-center">
        <div className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <Sparkles className="size-5" />
        </div>
        <p className="mt-3 text-sm font-medium">Nothing here yet</p>
        <p className="mt-1 max-w-[16rem] text-xs text-muted-foreground">
          Links, files, images and captured memories from this conversation collect here automatically.
        </p>
      </div>
    )
  } else {
    const groups = groupItemsByDay(visible, new Date())
    body = (
      <div className="relative pb-2">
        {/* the spine — one continuous line behind every node; a hint of gold at
            its origin (the golden thread) fading down. */}
        <div
          aria-hidden
          className="absolute bottom-3 left-6 top-3 w-px bg-gradient-to-b from-primary/40 via-border to-border"
        />
        {groups.map((group) => (
          <div key={group.label} className="pt-3 first:pt-0">
            <TimelineDayMarker label={group.label} />
            {group.items.map((item) => (
              <StreamContextRow
                key={item.key}
                workspaceId={workspaceId}
                item={item}
                onJumpToMessage={onJumpToMessage}
                onOpenThread={onOpenThread}
                onOpenMemo={onOpenMemo}
              />
            ))}
          </div>
        ))}
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
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

      {(total > 0 || isLoading) && (
        <div className="flex shrink-0 items-center gap-1.5 overflow-x-auto border-b px-3 py-2 [-webkit-mask-image:linear-gradient(to_right,#000_calc(100%_-_20px),transparent)] [mask-image:linear-gradient(to_right,#000_calc(100%_-_20px),transparent)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {chips.map((chip) => {
            const active = effectiveFilter === chip.value
            return (
              <button
                key={chip.value}
                type="button"
                onClick={() => setFilter(chip.value)}
                className={cn(
                  "shrink-0 rounded-full px-2.5 py-1 text-xs font-medium transition-colors",
                  active
                    ? "bg-foreground text-background"
                    : "bg-muted text-muted-foreground hover:bg-accent hover:text-foreground"
                )}
              >
                {chip.label}
                <span className={cn("ml-1 tabular-nums", active ? "opacity-80" : "opacity-60")}>{chip.count}</span>
              </button>
            )
          })}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-2">{body}</div>
    </div>
  )
}
