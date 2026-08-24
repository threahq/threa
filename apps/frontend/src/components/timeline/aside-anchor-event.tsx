import { useMemo } from "react"
import { StreamTypes, type AsideAnchoredEventPayload, type StreamEvent } from "@threa/types"
import { useWorkspaceStreams } from "@/stores/workspace-store"
import { useAsideState } from "@/stores/aside-store"
import { useResumeAside } from "@/hooks/use-open-aside"
import { STREAM_ICONS, streamFallbackLabel, streamLabel } from "@/lib/streams"
import { formatRelativeTime } from "@/lib/dates"
import { cn } from "@/lib/utils"

const AsideGlyph = STREAM_ICONS[StreamTypes.ASIDE]

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
    // The label's space is reserved: it fades in rather than appearing, so a
    // hovered row never changes height and the timeline never shifts (INV-21).
    <button
      type="button"
      onClick={() =>
        resume({
          asideId,
          hostStreamId: event.streamId,
          ...(payload?.conversationId && { conversationId: payload.conversationId }),
        })
      }
      aria-label={`Resume aside: ${title}`}
      data-aside-id={asideId}
      data-state={isOpen ? "open" : "closed"}
      className={cn(
        "group flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors sm:px-6",
        "hover:bg-primary/[0.04] focus-visible:bg-primary/[0.04] focus-visible:outline-none",
        isOpen && "bg-primary/[0.03]"
      )}
    >
      <AsideGlyph
        className={cn(
          "h-3 w-3 shrink-0 transition-colors",
          isOpen ? "text-primary" : "text-primary/60 group-hover:text-primary"
        )}
        aria-hidden
      />
      <span className="min-w-0 shrink truncate text-primary">{title}</span>
      <span
        aria-hidden
        className={cn(
          "h-px min-w-4 flex-1 bg-gradient-to-r transition-opacity",
          isOpen ? "from-primary/70 to-primary/10" : "from-primary/50 to-primary/10 opacity-70",
          "group-hover:opacity-100"
        )}
      />
      <span
        aria-hidden
        className="shrink-0 rounded-full bg-primary/10 px-2 py-px font-medium text-primary opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
      >
        {isOpen ? "Open" : "Resume"}
      </span>
      <span className="shrink-0 text-muted-foreground">{age}</span>
    </button>
  )
}
