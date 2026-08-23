import { useMemo } from "react"
import { StreamTypes, type AsideAnchoredEventPayload, type StreamEvent } from "@threa/types"
import { useWorkspaceStreams } from "@/stores/workspace-store"
import { useAsideState } from "@/stores/aside-store"
import { useResumeAside } from "@/hooks/use-open-aside"
import { streamFallbackLabel, streamLabel } from "@/lib/streams"
import { formatRelativeTime } from "@/lib/dates"
import { cn } from "@/lib/utils"

interface AsideAnchorEventProps {
  event: StreamEvent
  workspaceId: string
}

/**
 * The creator-only trace of an aside in its host stream (`aside:anchored`).
 * Title and archived state are a live join against the cached aside stream row
 * (the event is immutable); an archived aside leaves no row. The row is the
 * resume handle: Resume reveals on hover/focus (opacity only, INV-21) and
 * re-opens the aside in the surface it was last read in — silently (INV-63).
 */
export function AsideAnchorEvent({ event, workspaceId }: AsideAnchorEventProps) {
  const payload = event.payload as AsideAnchoredEventPayload | undefined
  const asideId = payload?.asideId
  const streams = useWorkspaceStreams(workspaceId)
  const aside = useMemo(() => streams.find((stream) => stream.id === asideId), [streams, asideId])
  const open = useAsideState()
  const resume = useResumeAside()
  if (!asideId || aside?.archivedAt) return null

  const isOpen = open?.asideId === asideId
  const title = aside ? streamLabel(aside) : streamFallbackLabel(StreamTypes.ASIDE, "generic")
  const age = formatRelativeTime(new Date(event.createdAt), new Date(), undefined, { terse: true })

  return (
    <div
      className="group flex items-center gap-2 px-3 py-1 text-xs sm:px-6"
      data-aside-id={asideId}
      data-state={isOpen ? "open" : "closed"}
    >
      <span className="min-w-0 shrink truncate text-primary">{title}</span>
      <span
        aria-hidden
        className={cn(
          "h-px min-w-4 flex-1 bg-gradient-to-r from-primary/60 to-primary/10 transition-opacity",
          !isOpen && "opacity-70 group-hover:opacity-100"
        )}
      />
      <button
        type="button"
        onClick={() =>
          resume({
            asideId,
            hostStreamId: event.streamId,
            ...(payload?.conversationId && { conversationId: payload.conversationId }),
          })
        }
        className="shrink-0 rounded px-1 text-primary opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring [@media(hover:none)]:opacity-100"
      >
        Resume
      </button>
      <span className="shrink-0 text-muted-foreground">{age}</span>
    </div>
  )
}
