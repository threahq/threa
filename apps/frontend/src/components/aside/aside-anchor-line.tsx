import { Link, useLocation, useSearchParams } from "react-router-dom"
import { useAsideAnchor } from "@/hooks/use-aside-anchor"
import { useStreamName } from "@/hooks/use-stream-name"

interface AsideAnchorLineProps {
  workspaceId: string
  /** The stream this aside sits beside. */
  hostStreamId: string
  /** The message the aside was opened from, when it was opened from one. */
  anchorId?: string | null
}

/**
 * Where this aside is anchored, as one line under the header: the message it
 * was opened from and the way back to it. A line, not a breadcrumb — an aside
 * has one place it belongs to and it is always this host stream, so the line
 * states it and offers the jump.
 *
 * Local-first, like every other in-app pointer to a message
 * (`use-in-app-link-chip`): the anchor is a message in the stream the viewer
 * is reading, so its author and time come from the timeline cache with no
 * round-trip. Uncached (or anchored to the stream rather than a message), it
 * names the stream instead of inventing an author.
 */
export function AsideAnchorLine({ workspaceId, hostStreamId, anchorId }: AsideAnchorLineProps) {
  const { pathname } = useLocation()
  const [searchParams] = useSearchParams()
  const hostName = useStreamName(workspaceId, hostStreamId, "breadcrumb")
  const anchored = useAsideAnchor(workspaceId, hostStreamId, anchorId)

  const onHostPage = pathname.endsWith(`/s/${hostStreamId}`)
  const hostPageSearch = (() => {
    const next = new URLSearchParams(searchParams)
    next.set("m", anchorId ?? "")
    return `?${next.toString()}`
  })()

  const label = anchored
    ? `Anchored to ${anchored.author} ${anchored.at}`
    : `Anchored in ${hostName ?? "this conversation"}`

  return (
    <div className="flex h-7 shrink-0 items-center gap-2 border-b bg-muted/20 px-3 text-[11px] text-muted-foreground">
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {anchorId && (
        // `?m=` is how the app scrolls a timeline to a message, and the aside's
        // own state is keyed by pathname, so the jump never disturbs it
        // (INV-40). Built on top of the page's other params — a thread panel,
        // a conversation overlay, a board's filters — rather than replacing
        // them; a board host has no timeline to scroll, so the jump goes to the
        // host stream's own page instead of doing nothing there.
        <Link
          to={onHostPage ? { pathname, search: hostPageSearch } : `/w/${workspaceId}/s/${hostStreamId}?m=${anchorId}`}
          className="shrink-0 rounded text-[11px] font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          Scroll to it
        </Link>
      )}
    </div>
  )
}
