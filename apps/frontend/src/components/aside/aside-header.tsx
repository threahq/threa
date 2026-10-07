import { X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { TooltipProvider } from "@/components/ui/tooltip"
import { closeAside } from "@/stores/aside-store"
import { streamFallbackLabel, streamLabel } from "@/lib/streams"
import { StreamTypes, type Stream } from "@threahq/types"
import { cn } from "@/lib/utils"
import { AsideAnchorLine } from "./aside-anchor-line"
import { ASIDE_META, AsideGlyph, AsidePrivateBadge } from "./aside-chrome"
import { useAsideDrafts } from "./use-aside-drafts"

/** The aside's title bar on desktop: what it is, where it came from, and its close. */
export function AsideHeader({
  workspaceId,
  asideId,
  hostStreamId,
  aside,
  className,
}: {
  workspaceId: string
  asideId: string
  hostStreamId: string
  aside: Stream | undefined
  className?: string
}) {
  const drafts = useAsideDrafts(workspaceId, asideId)
  const title = aside ? streamLabel(aside) : streamFallbackLabel(StreamTypes.ASIDE, "generic")
  return (
    <TooltipProvider delayDuration={300}>
      <header className={cn("flex h-12 shrink-0 items-center gap-2.5 border-b px-4", className)}>
        <AsideGlyph className="h-4 w-4 shrink-0 text-primary" aria-hidden />
        <h2 className="min-w-0 truncate text-[13px] font-semibold tracking-tight">{title}</h2>
        <AsidePrivateBadge />
        <AsideAnchorLine
          workspaceId={workspaceId}
          hostStreamId={hostStreamId}
          anchorId={aside?.parentAnchorId}
          variant="chip"
        />
        <span className="flex-1" />
        {drafts.length > 0 && (
          <span className={ASIDE_META}>
            {drafts.length} {drafts.length === 1 ? "draft" : "drafts"}
          </span>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-muted-foreground"
          aria-label="Close aside"
          onClick={closeAside}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </header>
    </TooltipProvider>
  )
}
