import { useMemo } from "react"
import { Loader2, MessageSquareDashed } from "lucide-react"
import { isAsideHostType, StreamTypes } from "@threa/types"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { streamLabel } from "@/lib/streams"
import { useWorkspaceStreams, useWorkspaceUnreadState } from "@/stores/workspace-store"
import { useStreamFromStore } from "@/stores/stream-store"
import { useAgentActivityForStream } from "@/stores/agent-activity-store"
import { useAsideState } from "@/stores/aside-store"
import { useOpenAside, useResumeAside } from "@/hooks/use-open-aside"
import { ATTENTION_LABEL, resolveAttention } from "@/components/timeline/aside-anchor-event"

interface AsideHeaderChipProps {
  workspaceId: string
  stream: {
    id: string
    type: string
    e2eEnabled?: boolean | null
    archivedAt?: string | null
    rootStreamId?: string | null
  }
  /** Phone: glyph only. */
  compact?: boolean
}

/**
 * The aside's place in the stream header. With no aside on this stream it
 * opens one anchored to what is on screen (the palette's "Open an aside here"
 * by another handle). With one, it carries the anchor row's state — grey at
 * rest or while Ariadne works, gold for an unread reply or while open — and
 * resumes the newest, so "she answered" is visible without scrolling to the
 * row. Renders nothing where an aside cannot be opened.
 */
export function AsideHeaderChip({ workspaceId, stream, compact = false }: AsideHeaderChipProps) {
  const streams = useWorkspaceStreams(workspaceId)
  const newest = useMemo(
    () =>
      streams
        .filter((row) => row.type === StreamTypes.ASIDE && row.parentStreamId === stream.id && !row.archivedAt)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0],
    [streams, stream.id]
  )
  const root = useStreamFromStore(stream.rootStreamId ?? undefined)
  const open = useAsideState()
  const openAside = useOpenAside(workspaceId)
  const resume = useResumeAside()
  const unread = useWorkspaceUnreadState(workspaceId)?.unreadCounts[newest?.id ?? ""] ?? 0
  const working = useAgentActivityForStream(workspaceId, newest?.id).length > 0

  const canOpen = isAsideHostType(stream.type) && !stream.e2eEnabled && !stream.archivedAt && !root?.archivedAt
  if (!newest && !canOpen) return null

  const attention = newest ? resolveAttention(open?.asideId === newest.id, working, unread) : "quiet"
  const highlighted = attention === "new" || attention === "open"
  const label = newest
    ? `${attention === "open" ? "Open" : "Resume"} aside: ${streamLabel(newest)}${ATTENTION_LABEL[attention]}`
    : "Open an aside"
  const onClick = () => {
    if (newest) resume({ hostStreamId: stream.id, asideId: newest.id })
    else void openAside({ kind: "stream", hostStreamId: stream.id }).catch(() => {})
  }
  const glyph =
    attention === "working" ? (
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
    ) : (
      <MessageSquareDashed className="h-4 w-4" aria-hidden="true" />
    )

  return (
    <Button
      variant="ghost"
      size={compact ? "icon" : "sm"}
      aria-label={label}
      title={label}
      data-testid="aside-header-chip"
      data-attention={attention}
      onClick={onClick}
      className={cn(
        compact ? "h-8 w-8" : "h-8 gap-1.5 px-2",
        highlighted ? "bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary" : "text-muted-foreground"
      )}
    >
      {glyph}
      {!compact && <span className="text-xs font-medium">{attention === "new" ? "New reply" : "Aside"}</span>}
    </Button>
  )
}
