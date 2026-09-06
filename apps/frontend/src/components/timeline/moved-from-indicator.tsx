import { CornerDownRight } from "lucide-react"
import type { MovedFromProvenance } from "@threahq/types"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { RelativeTime } from "@/components/relative-time"
import { useActors } from "@/hooks"
import { cn } from "@/lib/utils"

interface MovedFromIndicatorProps {
  workspaceId: string
  movedFrom: MovedFromProvenance
  /**
   * When provided, the badge becomes a click target that fires this
   * callback (e.g. opens the move drill-in drawer). Tooltip-on-hover
   * behavior is preserved either way. Omit for tooltip-only display
   * (e.g. when the destination tombstone hasn't hydrated yet).
   */
  onClick?: () => void
}

function formatSourceName(displayName: string | null, slug: string | null): string | null {
  if (displayName) return displayName
  if (slug) return `#${slug}`
  return null
}

/**
 * Subtle "moved here" badge shown next to a message's timestamp when the
 * message was relocated into this stream by a move-to-thread operation.
 * The icon doubles as the visual identity of the move action everywhere
 * (context menus + tombstones use the same `CornerDownRight`).
 *
 * On desktop the badge is clickable when an `onClick` is wired — saves
 * users a right-click → context-menu hop to the same drawer the menu
 * entry opens. Mobile users without hover discoverability still reach
 * the drawer via the message context menu's "Show move details" entry.
 */
export function MovedFromIndicator({ workspaceId, movedFrom, onClick }: MovedFromIndicatorProps) {
  const { getActorName } = useActors(workspaceId)
  const moverName = getActorName(movedFrom.movedBy, movedFrom.movedByType)
  const sourceName = formatSourceName(movedFrom.sourceStreamDisplayName, movedFrom.sourceStreamSlug)
  const ariaLabel = sourceName ? `Moved from ${sourceName}` : "Moved from another stream"

  const tooltipContent = (
    <TooltipContent side="top" className="text-xs">
      {sourceName ? (
        <>
          Moved here by {moverName} from <span className="font-medium">{sourceName}</span>{" "}
          <RelativeTime date={movedFrom.movedAt} />
        </>
      ) : (
        <>
          Moved here by {moverName} <RelativeTime date={movedFrom.movedAt} />
        </>
      )}
    </TooltipContent>
  )

  if (onClick) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={(event) => {
              // Don't bubble into row-level handlers (e.g. batch-select
              // toggles when the row is clickable in selection mode).
              event.stopPropagation()
              onClick()
            }}
            aria-label={ariaLabel}
            className={cn(
              "inline-flex items-center text-muted-foreground hover:text-foreground cursor-pointer",
              "rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
            )}
          >
            <CornerDownRight className="h-3 w-3" aria-hidden="true" />
          </button>
        </TooltipTrigger>
        {tooltipContent}
      </Tooltip>
    )
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          className="inline-flex items-center text-muted-foreground hover:text-foreground cursor-default rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
          aria-label={ariaLabel}
        >
          <CornerDownRight className="h-3 w-3" aria-hidden="true" />
        </span>
      </TooltipTrigger>
      {tooltipContent}
    </Tooltip>
  )
}
