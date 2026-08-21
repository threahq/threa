import { useMemo } from "react"
import { StreamTypes, type AsideAnchoredEventPayload, type StreamEvent } from "@threa/types"
import { useWorkspaceStreams } from "@/stores/workspace-store"
import { streamFallbackLabel, streamLabel } from "@/lib/streams"
import { formatRelativeTime } from "@/lib/dates"
import { Button } from "@/components/ui/button"

interface AsideAnchorEventProps {
  event: StreamEvent
  workspaceId: string
}

/**
 * The creator-only trace of an aside in its host stream (`aside:anchored`): a
 * hairline in the primary tone with the aside's title and age riding on it.
 * Title and state are a live join against the cached aside stream row — the
 * event is immutable, so a rename shows without a new event and an archived
 * aside leaves no row at all. Resume is revealed on hover/focus but keeps its
 * footprint, so the row never shifts (INV-21); the aside surface it opens lands
 * in a later layer.
 */
export function AsideAnchorEvent({ event, workspaceId }: AsideAnchorEventProps) {
  const payload = event.payload as AsideAnchoredEventPayload | undefined
  const asideId = payload?.asideId
  const streams = useWorkspaceStreams(workspaceId)
  const aside = useMemo(() => streams.find((stream) => stream.id === asideId), [streams, asideId])
  if (!asideId || aside?.archivedAt) return null

  const title = aside ? streamLabel(aside) : streamFallbackLabel(StreamTypes.ASIDE, "generic")
  const age = formatRelativeTime(new Date(event.createdAt), new Date(), undefined, { terse: true })

  return (
    <div className="group flex items-center gap-2 px-3 py-1 text-xs sm:px-6" data-aside-id={asideId}>
      <span className="min-w-0 shrink truncate text-primary">{title}</span>
      <span aria-hidden className="h-px min-w-4 flex-1 bg-gradient-to-r from-primary/60 to-primary/10" />
      <span className="shrink-0 text-muted-foreground">{age}</span>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-6 shrink-0 px-2 text-xs opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
      >
        Resume
      </Button>
    </div>
  )
}
