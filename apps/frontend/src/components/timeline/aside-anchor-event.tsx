import { useMemo } from "react"
import { StreamTypes, type AsideAnchoredEventPayload, type StreamEvent } from "@threa/types"
import { useWorkspaceStreams } from "@/stores/workspace-store"
import { streamFallbackLabel, streamLabel } from "@/lib/streams"
import { formatRelativeTime } from "@/lib/dates"

interface AsideAnchorEventProps {
  event: StreamEvent
  workspaceId: string
}

/**
 * The creator-only trace of an aside in its host stream (`aside:anchored`).
 * Title and archived state are a live join against the cached aside stream row
 * (the event is immutable); an archived aside leaves no row.
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
    <div className="flex items-center gap-2 px-3 py-1 text-xs sm:px-6" data-aside-id={asideId}>
      <span className="min-w-0 shrink truncate text-primary">{title}</span>
      <span aria-hidden className="h-px min-w-4 flex-1 bg-gradient-to-r from-primary/60 to-primary/10" />
      <span className="shrink-0 text-muted-foreground">{age}</span>
    </div>
  )
}
