import { useMemo } from "react"
import { Loader2 } from "lucide-react"
import { StreamTypes, type AsideAnchoredEventPayload, type StreamEvent } from "@threa/types"
import { useWorkspaceStreams, useWorkspaceUnreadState } from "@/stores/workspace-store"
import { useAgentActivityForStream } from "@/stores/agent-activity-store"
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
 * What the row is telling the reader. `open`: the aside is on screen. `working`:
 * Ariadne is answering in it. `new`: an answer landed since the aside was last
 * read — the aside's own unread, which only its companion can raise (the
 * creator is its one member, and own sends never count). `quiet`: nothing new.
 */
export type AsideAnchorAttention = "open" | "working" | "new" | "quiet"

export function resolveAttention(isOpen: boolean, working: boolean, unread: number): AsideAnchorAttention {
  if (isOpen) return "open"
  if (working) return "working"
  return unread > 0 ? "new" : "quiet"
}

export const ATTENTION_LABEL: Record<AsideAnchorAttention, string> = {
  open: "",
  working: " (Ariadne is working)",
  new: " (new reply)",
  quiet: "",
}

/**
 * The creator-only trace of an aside in its host stream (`aside:anchored`).
 * Title and archived state are a live join against the cached aside stream row
 * (the event is immutable); an archived aside leaves no row. The row is the
 * resume handle: Resume reveals on hover/focus (opacity only, INV-21) and
 * re-opens the aside in the surface it was last read in — silently (INV-63).
 * The aside is a pull surface with no badge anywhere else, so this row is also
 * where an answer written while it was closed shows: gold when there is one,
 * grey until then.
 */
export function AsideAnchorEvent({ event, workspaceId }: AsideAnchorEventProps) {
  const payload = event.payload as AsideAnchoredEventPayload | undefined
  const asideId = payload?.asideId
  const streams = useWorkspaceStreams(workspaceId)
  const aside = useMemo(() => streams.find((stream) => stream.id === asideId), [streams, asideId])
  const open = useAsideState()
  const resume = useResumeAside()
  const unread = useWorkspaceUnreadState(workspaceId)?.unreadCounts[asideId ?? ""] ?? 0
  const working = useAgentActivityForStream(workspaceId, asideId).length > 0
  if (!asideId || aside?.archivedAt) return null

  const isOpen = open?.asideId === asideId
  const attention = resolveAttention(isOpen, working, unread)
  // Gold only when there is something here for the reader: an answer not yet
  // read, or the aside itself on screen. Waiting on Ariadne is grey too — the
  // spinner says she is working, the colour would say "come and look".
  const highlighted = attention === "new" || attention === "open"
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
      aria-label={`${isOpen ? "Open" : "Resume"} aside: ${title}${ATTENTION_LABEL[attention]}`}
      data-aside-id={asideId}
      data-state={isOpen ? "open" : "closed"}
      data-attention={attention}
      className={cn(
        "group flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors sm:px-6",
        "hover:bg-primary/[0.04] focus-visible:bg-primary/[0.04] focus-visible:outline-none",
        isOpen && "bg-primary/[0.03]"
      )}
    >
      {attention === "working" ? (
        <Loader2 className="h-3 w-3 shrink-0 animate-spin text-muted-foreground/70" aria-hidden />
      ) : (
        <AsideGlyph
          className={cn(
            "h-3 w-3 shrink-0 transition-colors",
            highlighted ? "text-primary" : "text-muted-foreground/70 group-hover:text-primary"
          )}
          aria-hidden
        />
      )}
      <span
        className={cn(
          "min-w-0 shrink truncate transition-colors",
          highlighted ? "text-primary" : "text-muted-foreground group-hover:text-primary"
        )}
      >
        {title}
      </span>
      <span
        aria-hidden
        className={cn(
          "h-px min-w-4 flex-1 bg-gradient-to-r transition-opacity",
          highlighted
            ? "from-primary/70 to-primary/10"
            : "from-border to-border/20 group-hover:from-primary/50 group-hover:to-primary/10",
          !isOpen && "opacity-70 group-hover:opacity-100"
        )}
      />
      <span
        aria-hidden
        className={cn(
          "shrink-0 rounded-full px-2 py-px font-medium opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 [@media(hover:none)]:opacity-100",
          highlighted
            ? "bg-primary/10 text-primary"
            : "bg-muted text-muted-foreground group-hover:bg-primary/10 group-hover:text-primary"
        )}
      >
        {isOpen ? "Open" : "Resume"}
      </span>
      <span className="shrink-0 text-muted-foreground">{age}</span>
    </button>
  )
}
