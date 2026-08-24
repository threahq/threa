import { useMemo } from "react"
import { X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { TooltipProvider } from "@/components/ui/tooltip"
import { useWorkspaceStreams } from "@/stores/workspace-store"
import { closeAside } from "@/stores/aside-store"
import { streamFallbackLabel, streamLabel } from "@/lib/streams"
import { StreamTypes } from "@threa/types"
import { AsideAnchorLine } from "./aside-anchor-line"
import { AsideConversation } from "./aside-conversation"
import { AsideDrafts } from "./aside-drafts"
import { AsideGlyph, AsidePrivateBadge } from "./aside-chrome"
import { AsideSplitHandle } from "./aside-split-handle"
import { useAsideDraftSurface } from "./use-aside-draft-surface"
import { useAsideSplit } from "./use-aside-split"

interface AsidePaneProps {
  workspaceId: string
  asideId: string
  /** The stream the aside sits beside — the hand-off's destination. */
  hostStreamId: string
  /** The draft scope a hand-off files into (`OpenAsideState.originScope`). */
  originScope: string
}

/**
 * The aside in one column, for the phone sheet: what it is, what it is
 * anchored to, what you are writing, and the conversation you are writing it
 * from. Drafts sit above the chat because the chat owns the bottom edge — its
 * composer is where the cursor rests, and a draft opening under it would keep
 * moving the one input that never moves anywhere else in the app.
 */
export function AsidePane({ workspaceId, asideId, hostStreamId, originScope }: AsidePaneProps) {
  const draftSurface = useAsideDraftSurface({ workspaceId, asideId, hostStreamId, originScope })
  // No gaps in this column: the drafts region's border and the divider sit
  // flush, so only the divider's hairline is between the two halves.
  const split = useAsideSplit(asideId, { reservedHeight: 1 })
  const streams = useWorkspaceStreams(workspaceId)
  const aside = useMemo(() => streams.find((stream) => stream.id === asideId), [streams, asideId])
  const title = aside ? streamLabel(aside) : streamFallbackLabel(StreamTypes.ASIDE, "generic")

  return (
    <div
      data-testid="aside-pane"
      data-aside-id={asideId}
      data-editor-zone="aside"
      className="flex h-full min-h-0 flex-col border-t-2 border-primary/70 bg-card"
    >
      <TooltipProvider delayDuration={300}>
        <header className="flex h-11 shrink-0 items-center gap-2 border-b pl-3 pr-1.5">
          <AsideGlyph className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
          <h2 className="min-w-0 truncate text-[13px] font-semibold tracking-tight">{title}</h2>
          <AsidePrivateBadge />
          <span className="flex-1" />
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
      <AsideAnchorLine workspaceId={workspaceId} hostStreamId={hostStreamId} anchorId={aside?.parentAnchorId} />
      <div ref={split.containerRef} className="flex min-h-0 flex-1 flex-col">
        <AsideDrafts
          workspaceId={workspaceId}
          asideId={asideId}
          surface={draftSurface}
          className="shrink-0 border-b bg-muted/20"
          style={draftSurface.openScope ? { height: split.height } : undefined}
        />
        {draftSurface.openScope && <AsideSplitHandle split={split} />}
        <div className="relative min-h-0 flex-1">
          <AsideConversation
            workspaceId={workspaceId}
            asideId={asideId}
            aside={aside}
            autoFocus={false}
            onInsertAgentBlock={draftSurface.insertAgentBlock}
          />
        </div>
      </div>
    </div>
  )
}
