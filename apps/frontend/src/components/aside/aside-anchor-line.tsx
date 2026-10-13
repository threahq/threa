import { Link } from "react-router-dom"
import { Anchor, CornerUpLeft } from "lucide-react"
import { usePanel } from "@/contexts"
import { useAsideAnchor } from "@/hooks/use-aside-anchor"
import { useStreamName } from "@/hooks/use-stream-name"
import { panelIdsOf } from "@/lib/panel-tabs"
import { cn } from "@/lib/utils"

interface AsideAnchorLineProps {
  workspaceId: string
  /** The stream this aside sits beside. */
  hostStreamId: string
  /** The message the aside was opened from, when it was opened from one. */
  anchorId?: string | null
  /** `chip` rides the column's header; `line` is the phone sheet's own row under it. */
  variant?: "line" | "chip"
  /** The chip down to its glyph. */
  compact?: boolean
}

/**
 * Where this aside is anchored, and the way back to it — the whole thing is
 * the link, not a "Scroll to it" tacked on the end. An aside belongs to one
 * message in one stream, so the sentence naming that message IS the jump.
 *
 * The jump is offered whenever there is an anchor id; only the wording depends
 * on the local cache. Author and time come from the timeline cache with no
 * round-trip (like `use-in-app-link-chip`), and uncached it names the stream
 * instead of inventing an author — but it still goes to the same message.
 */
export function AsideAnchorLine({
  workspaceId,
  hostStreamId,
  anchorId,
  variant = "line",
  compact = false,
}: AsideAnchorLineProps) {
  const { layout, hasTabs, getTabUrl } = usePanel()
  const hostName = useStreamName(workspaceId, hostStreamId, "breadcrumb")
  const anchored = useAsideAnchor(workspaceId, hostStreamId, anchorId)

  const prefix = anchored ? "Anchored to " : "Anchored in "
  const where = anchored ? `${anchored.author} · ${anchored.at}` : (hostName ?? "this conversation")
  const label = (
    <span className={compact ? "sr-only" : "min-w-0 truncate"}>
      <span className="sr-only">{prefix}</span>
      <span className={cn(anchored && "font-medium text-foreground/85")}>{where}</span>
    </span>
  )
  const title = compact ? `${prefix}${where}` : undefined
  const chipSize = compact ? "shrink-0" : "min-w-0 shrink"

  const onHostPage = hasTabs && panelIdsOf(layout).includes(hostStreamId)
  const chip = variant === "chip"
  // `?m=` is how the app scrolls a timeline to a message, and the aside's own
  // state is keyed by the page, so the jump never disturbs it (INV-40). With the
  // host open in a pane, the jump works in that pane and keeps the rest of the
  // page — the panes, a conversation overlay — rather than replacing it; a board
  // host has no timeline to scroll, so the jump goes to the host stream's own page.
  const hostPaneHref = (messageId: string) => {
    const url = new URL(getTabUrl(hostStreamId), window.location.origin)
    url.searchParams.set("m", messageId)
    return `${url.pathname}${url.search}`
  }
  const to =
    onHostPage && anchorId
      ? hostPaneHref(anchorId)
      : `/w/${workspaceId}/s/${hostStreamId}${anchorId ? `?m=${anchorId}` : ""}`

  // Already looking at the anchor's own stream with nothing to scroll to: the
  // line still says where you are, it just isn't pretending to go anywhere.
  if (onHostPage && !anchorId) {
    return (
      <div
        data-testid="aside-anchor-line"
        title={title}
        className={cn(
          "flex items-center gap-1.5 text-[11px] text-muted-foreground",
          chip ? cn(chipSize, "rounded-full border px-2.5 py-1") : "h-7 shrink-0 border-b bg-primary/[0.025] px-3"
        )}
      >
        <Anchor className="h-3 w-3 shrink-0" aria-hidden />
        {label}
      </div>
    )
  }

  return (
    <Link
      to={to}
      data-testid="aside-anchor-line"
      title={title}
      className={cn(
        "group flex items-center gap-1.5 text-[11px] text-muted-foreground transition-colors",
        "hover:text-primary focus-visible:text-primary focus-visible:outline-none",
        chip
          ? cn(chipSize, "rounded-full border px-2.5 py-1 hover:border-primary/40 hover:bg-primary/[0.06]")
          : "h-7 min-w-0 shrink-0 border-b bg-primary/[0.025] px-3 hover:bg-primary/[0.06]"
      )}
    >
      <Anchor className="h-3 w-3 shrink-0" aria-hidden />
      {label}
      {!compact && (
        <CornerUpLeft
          className="h-3 w-3 shrink-0 text-muted-foreground/50 transition-colors group-hover:text-primary"
          aria-hidden
        />
      )}
    </Link>
  )
}
