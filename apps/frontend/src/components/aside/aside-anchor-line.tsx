import { Link, useLocation, useSearchParams } from "react-router-dom"
import { CornerUpLeft } from "lucide-react"
import { useAsideAnchor } from "@/hooks/use-aside-anchor"
import { useStreamName } from "@/hooks/use-stream-name"
import { cn } from "@/lib/utils"

interface AsideAnchorLineProps {
  workspaceId: string
  /** The stream this aside sits beside. */
  hostStreamId: string
  /** The message the aside was opened from, when it was opened from one. */
  anchorId?: string | null
  /** `chip` rides the fullscreen room bar; `line` is the dock's own row under the header. */
  variant?: "line" | "chip"
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
export function AsideAnchorLine({ workspaceId, hostStreamId, anchorId, variant = "line" }: AsideAnchorLineProps) {
  const { pathname } = useLocation()
  const [searchParams] = useSearchParams()
  const hostName = useStreamName(workspaceId, hostStreamId, "breadcrumb")
  const anchored = useAsideAnchor(workspaceId, hostStreamId, anchorId)

  const label = anchored ? (
    <>
      Anchored to <span className="font-medium text-foreground/85">{`${anchored.author} · ${anchored.at}`}</span>
    </>
  ) : (
    `Anchored in ${hostName ?? "this conversation"}`
  )

  const onHostPage = pathname.endsWith(`/s/${hostStreamId}`)
  // `?m=` is how the app scrolls a timeline to a message, and the aside's own
  // state is keyed by pathname, so the jump never disturbs it (INV-40). Built
  // on top of the page's other params — a thread panel, a conversation
  // overlay, a board's filters — rather than replacing them; a board host has
  // no timeline to scroll, so the jump goes to the host stream's own page.
  const hostPageSearch = () => {
    const next = new URLSearchParams(searchParams)
    next.set("m", anchorId ?? "")
    return `?${next.toString()}`
  }
  const to =
    onHostPage && anchorId
      ? { pathname, search: hostPageSearch() }
      : `/w/${workspaceId}/s/${hostStreamId}${anchorId ? `?m=${anchorId}` : ""}`

  const chip = variant === "chip"
  // Already looking at the anchor's own stream with nothing to scroll to: the
  // line still says where you are, it just isn't pretending to go anywhere.
  if (onHostPage && !anchorId) {
    return (
      <div
        data-testid="aside-anchor-line"
        className={cn(
          "flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground",
          chip ? "rounded-full border px-2.5 py-1" : "h-7 border-b bg-primary/[0.025] px-3"
        )}
      >
        <span className="min-w-0 truncate">{label}</span>
      </div>
    )
  }

  return (
    <Link
      to={to}
      data-testid="aside-anchor-line"
      className={cn(
        "group flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground transition-colors",
        "hover:text-primary focus-visible:text-primary focus-visible:outline-none",
        chip
          ? "rounded-full border px-2.5 py-1 hover:border-primary/40 hover:bg-primary/[0.06]"
          : "h-7 border-b bg-primary/[0.025] px-3 hover:bg-primary/[0.06]"
      )}
    >
      <span className="min-w-0 truncate">{label}</span>
      <CornerUpLeft
        className="h-3 w-3 shrink-0 text-muted-foreground/50 transition-colors group-hover:text-primary"
        aria-hidden
      />
    </Link>
  )
}
