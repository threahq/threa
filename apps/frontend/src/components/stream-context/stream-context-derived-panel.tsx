import { useMemo } from "react"
import { useStreamEvents } from "@/stores/stream-store"
import { useStreamDelegations } from "@/hooks/use-stream-delegations"
import { deriveStreamContext } from "@/lib/stream-context/derive"
import { delegationContextItems, withDelegations } from "@/lib/stream-context/delegations"
import { StreamContextRow } from "./stream-context-row"
import {
  chipsFromCounts,
  ContextChipRow,
  ContextEmpty,
  ContextPanelHeader,
  ContextSkeleton,
  ContextTimeline,
  useContextFilter,
  type Filter,
  type StreamContextPanelProps,
} from "./stream-context-chrome"

/**
 * The pre-index panel: context derived from the loaded timeline window only.
 * Still the path for sealed streams (the server holds ciphertext, never an
 * index) and for workspaces with `streamContextIndex` off.
 */
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
  const { items, counts, total } = useMemo(
    () => withDelegations(deriveStreamContext(events), delegationItems),
    [events, delegationItems]
  )

  const [filter, setFilter] = useContextFilter()

  // A previously-selected filter can empty out as the live event set changes
  // (e.g. a thread's last reply scrolls out of the loaded window); fall back to
  // "all" so the body never strands the user on an empty filter. The delegation
  // count isn't known until its query settles, so a `?context=delegation` deep
  // link holds the requested view instead of flickering All → Delegations.
  const filterSettled = filter !== "delegation" || !delegationsPending
  const effectiveFilter: Filter = filter !== "all" && filterSettled && counts[filter] === 0 ? "all" : filter
  const visible = effectiveFilter === "all" ? items : items.filter((i) => i.category === effectiveFilter)
  const isLoading = events === undefined || (delegationsPending && visible.length === 0)

  let body: React.ReactNode
  if (isLoading) {
    body = <ContextSkeleton />
  } else if (visible.length === 0) {
    body = <ContextEmpty />
  } else {
    body = (
      <ContextTimeline
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
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        {body}
      </div>
    </div>
  )
}
