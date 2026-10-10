import { Link } from "react-router-dom"
import { BreadcrumbItem, BreadcrumbLink, BreadcrumbPage, BreadcrumbSeparator } from "@/components/ui/breadcrumb"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useStreamTitlePreview } from "@/components/layout/stream-title-preview"
import { streamLabel } from "@/lib/streams"
import type { StreamType } from "@threahq/types"

interface StreamInfo {
  id: string
  type: StreamType
  displayName: string | null
  slug?: string | null
  rootStreamId?: string | null
}

interface AncestorBreadcrumbItemProps {
  stream: StreamInfo
  getNavigationUrl: (streamId: string) => string
  /** Max width for the item (responsive) */
  maxWidth?: number
}

/** Breadcrumb item for an ancestor stream: a link that shows it in this pane. */
export function AncestorBreadcrumbItem({ stream, getNavigationUrl, maxWidth = 120 }: AncestorBreadcrumbItemProps) {
  const displayName = streamLabel(stream, "breadcrumb")
  const { anchorProps, overlay } = useStreamTitlePreview(displayName)

  return (
    <div key={stream.id} className="contents">
      <BreadcrumbItem style={{ maxWidth }}>
        <Tooltip>
          <TooltipTrigger asChild>
            <BreadcrumbLink asChild>
              <Link to={getNavigationUrl(stream.id)} className="truncate block" {...anchorProps}>
                {displayName}
              </Link>
            </BreadcrumbLink>
          </TooltipTrigger>
          <TooltipContent>{displayName}</TooltipContent>
        </Tooltip>
      </BreadcrumbItem>
      <BreadcrumbSeparator />
      {overlay}
    </div>
  )
}

interface CurrentBreadcrumbItemProps {
  label: string
  maxWidth: number
}

/**
 * The trailing (current) breadcrumb step. Press-and-hold reveals the full label
 * on touch — the same affordance the ancestor links get — since the hover
 * tooltip never fires on a finger.
 */
export function CurrentBreadcrumbItem({ label, maxWidth }: CurrentBreadcrumbItemProps) {
  const { anchorProps, overlay } = useStreamTitlePreview(label)

  return (
    <BreadcrumbItem style={{ maxWidth }}>
      <Tooltip>
        <TooltipTrigger asChild>
          <BreadcrumbPage className="truncate" {...anchorProps}>
            {label}
          </BreadcrumbPage>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
      {overlay}
    </BreadcrumbItem>
  )
}
