import { useCallback, useMemo, useRef } from "react"
import type { VirtualizerHandle } from "virtua"
import { useStreamEvents } from "@/stores/stream-store"
import { useStreamDelegations } from "@/hooks/use-stream-delegations"
import { useStreamAgentOutcomes } from "@/hooks/use-agent-outcomes"
import { localStartOfDayMs } from "@/lib/dates"
import { markerIndexForDate, oldestItemIndex } from "@/lib/stream-context/grouping"
import { deriveStreamContext } from "@/lib/stream-context/derive"
import { delegationContextItems, withDelegations } from "@/lib/stream-context/delegations"
import { followUpContextItems, withFollowUps } from "@/lib/stream-context/follow-ups"
import { StreamContextRow } from "./stream-context-row"
import {
  AGENT_FILTER_CATEGORIES,
  chipsFromCounts,
  ContextChipRow,
  filterCount,
  ContextEmpty,
  ContextPanelHeader,
  ContextSkeleton,
  ContextTimeline,
  useContextFilter,
  type Filter,
  type StreamContextPanelProps,
} from "./stream-context-chrome"

/**
 * The sealed-stream panel: context derived from the loaded timeline window on
 * this device. The only reason this path still exists — the server holds
 * ciphertext for an E2E stream and can never index it, so there is nothing for
 * {@link StreamContextIndexPanel} to read. Every other stream is indexed.
 *
 * The consequences follow from having no index: this window is whatever the
 * timeline has loaded, so it neither pages nor searches, and its date jump can
 * only reach as far back as that window.
 */
const DAY_MS = 24 * 60 * 60 * 1000

export function StreamContextDerivedPanel({
  workspaceId,
  streamId,
  onClose,
  onJumpToMessage,
  onOpenThread,
  onOpenMemo,
  onOpenGallery,
  note,
}: StreamContextPanelProps & { note?: string }) {
  const events = useStreamEvents(streamId)
  // Delegations come from the authoritative list endpoint, not the loaded
  // window (statuses live in patch events — see delegationContextItems); the
  // query key is invalidated by stream-sync on delegation socket events, so an
  // open panel tracks transitions live. A populated feed doesn't block on the
  // fetch (rows appear when it lands), but the empty/skeleton decision does —
  // otherwise a delegations-only stream flashes "Nothing here yet" first.
  const delegationsQuery = useStreamDelegations(workspaceId, streamId)
  const delegationsPending = delegationsQuery.isPending
  const delegationItems = useMemo(
    () => delegationContextItems(delegationsQuery.data?.delegations ?? []),
    [delegationsQuery.data]
  )
  // Follow-ups come from the same kind of authoritative read: firing emits no
  // event at all, so a window-derived row would sit on `pending` forever.
  const outcomesQuery = useStreamAgentOutcomes(workspaceId, streamId)
  const followUpItems = useMemo(() => followUpContextItems(outcomesQuery.data?.items ?? []), [outcomesQuery.data])
  const { items, counts, total } = useMemo(
    () => withFollowUps(withDelegations(deriveStreamContext(events), delegationItems), followUpItems),
    [events, delegationItems, followUpItems]
  )

  const [filter, setFilter] = useContextFilter()

  // A previously-selected filter can empty out as the live event set changes
  // (e.g. a thread's last reply scrolls out of the loaded window); fall back to
  // "all" so the body never strands the user on an empty filter. The delegation
  // count isn't known until its query settles, so a `?context=delegation` deep
  // link holds the requested view instead of flickering All → Delegations.
  // The Agent chip stands for both agent categories, so it only settles once
  // both of their queries have.
  const agentPending = delegationsPending || outcomesQuery.isPending
  const filterSettled =
    (filter !== "delegation" || !delegationsPending) &&
    (filter !== "follow_up" || !outcomesQuery.isPending) &&
    (filter !== "agent" || !agentPending)
  const effectiveFilter: Filter =
    filter !== "all" && filterSettled && filterCount(counts, filter, total) === 0 ? "all" : filter
  // Memoized for its identity as much as its cost: the timeline's day grouping
  // is keyed on this array, and a fresh one per render would miss that memo.
  const visible = useMemo(() => {
    if (effectiveFilter === "agent") {
      const agentCategories: readonly string[] = AGENT_FILTER_CATEGORIES
      return items.filter((i) => agentCategories.includes(i.category))
    }
    if (effectiveFilter !== "all") return items.filter((i) => i.category === effectiveFilter)
    return items
  }, [items, effectiveFilter])
  const isLoading = events === undefined || ((delegationsPending || outcomesQuery.isPending) && visible.length === 0)

  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const listRef = useRef<VirtualizerHandle | null>(null)

  // Same jump affordance as the indexed panel, minus the paging: this path
  // renders the loaded window only, so that window's oldest row is as far back
  // as a date beyond it can land.
  const jumpToDate = useCallback(
    (date: Date) => {
      const now = new Date()
      let index = markerIndexForDate(visible, localStartOfDayMs(date) + DAY_MS, now)
      if (index === -1) index = oldestItemIndex(visible, now)
      if (index === -1) return
      listRef.current?.scrollToIndex(index, { align: "start" })
      scrollerRef.current?.focus({ preventScroll: true })
    },
    [visible]
  )

  let body: React.ReactNode
  if (isLoading) {
    body = <ContextSkeleton />
  } else if (visible.length === 0) {
    body = <ContextEmpty />
  } else {
    body = (
      <ContextTimeline
        scrollRef={scrollerRef}
        listRef={listRef}
        onJumpToDate={jumpToDate}
        items={visible}
        renderItem={(item) => (
          <StreamContextRow
            key={item.key}
            workspaceId={workspaceId}
            item={item}
            onJumpToMessage={onJumpToMessage}
            onOpenThread={onOpenThread}
            onOpenMemo={onOpenMemo}
            onOpenGallery={onOpenGallery}
          />
        )}
      />
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <ContextPanelHeader total={total} onClose={onClose} />
      {(total > 0 || isLoading) && (
        <ContextChipRow chips={chipsFromCounts(counts, total)} active={effectiveFilter} onSelect={setFilter} />
      )}
      {note && <p className="shrink-0 border-b px-3 py-1.5 text-[11px] text-muted-foreground">{note}</p>}
      <div
        ref={scrollerRef}
        // Focusable so a date jump can park focus here when the marker that
        // opened the menu is windowed out (Radix would otherwise return focus to
        // a removed node and drop it to <body>).
        tabIndex={-1}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]"
      >
        {body}
      </div>
    </div>
  )
}
