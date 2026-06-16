import { Link } from "react-router-dom"
import { BreadcrumbItem, BreadcrumbLink, BreadcrumbSeparator } from "@/components/ui/breadcrumb"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { streamLabel } from "@/lib/streams"
import type { StreamType } from "@threa/types"

interface StreamInfo {
  id: string
  type: StreamType
  displayName: string | null
  slug?: string | null
  rootStreamId?: string | null
}

interface StreamForLookup {
  id: string
  type: StreamType
  displayName: string | null
  slug?: string | null
}

/**
 * Short context label for a thread's root stream (sidebar: "Thread Name · #general").
 * Null when the thread has no root or the root isn't in `allStreams`.
 */
export function getThreadRootContext(
  thread: { rootStreamId: string | null },
  allStreams: StreamForLookup[]
): string | null {
  if (!thread.rootStreamId) return null

  const rootStream = allStreams.find((s) => s.id === thread.rootStreamId)
  if (!rootStream) return null

  return streamLabel(rootStream, "sidebar")
}

interface AncestorBreadcrumbItemProps {
  stream: StreamInfo
  isMainViewStream: boolean
  onClosePanel: () => void
  getNavigationUrl: (streamId: string) => string
  /** Max width for the item (responsive) */
  maxWidth?: number
}

/**
 * Breadcrumb item for an ancestor stream. The main-view stream renders a button
 * that closes the panel (INV-40); other streams render a navigation link.
 */
export function AncestorBreadcrumbItem({
  stream,
  isMainViewStream,
  onClosePanel,
  getNavigationUrl,
  maxWidth = 120,
}: AncestorBreadcrumbItemProps) {
  const displayName = streamLabel(stream, "breadcrumb")

  if (isMainViewStream) {
    return (
      <div key={stream.id} className="contents">
        <BreadcrumbItem style={{ maxWidth }}>
          <Tooltip>
            <TooltipTrigger asChild>
              <BreadcrumbLink asChild>
                <button
                  onClick={onClosePanel}
                  aria-label={`Return to ${displayName}`}
                  className="truncate block text-left hover:underline cursor-pointer bg-transparent border-0 p-0 font-inherit"
                >
                  {displayName}
                </button>
              </BreadcrumbLink>
            </TooltipTrigger>
            <TooltipContent>{displayName}</TooltipContent>
          </Tooltip>
        </BreadcrumbItem>
        <BreadcrumbSeparator />
      </div>
    )
  }

  return (
    <div key={stream.id} className="contents">
      <BreadcrumbItem style={{ maxWidth }}>
        <Tooltip>
          <TooltipTrigger asChild>
            <BreadcrumbLink asChild>
              <Link to={getNavigationUrl(stream.id)} className="truncate block">
                {displayName}
              </Link>
            </BreadcrumbLink>
          </TooltipTrigger>
          <TooltipContent>{displayName}</TooltipContent>
        </Tooltip>
      </BreadcrumbItem>
      <BreadcrumbSeparator />
    </div>
  )
}
