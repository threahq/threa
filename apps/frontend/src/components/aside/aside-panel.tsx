import { useMemo } from "react"
import { SidePanel, SidePanelTitle } from "@/components/ui/side-panel"
import { TooltipProvider } from "@/components/ui/tooltip"
import { PaneHeader, PanelTabTitle } from "@/components/panes"
import { createAsidePanelId, usePanel, useRevealReady } from "@/contexts"
import { useWorkspaceStreams } from "@/stores/workspace-store"
import { useAsideState } from "@/stores/aside-store"
import { cn } from "@/lib/utils"
import { AsideAnchorLine } from "./aside-anchor-line"
import { ASIDE_META, AsideGlyph, AsidePrivateBadge } from "./aside-chrome"
import { AsideConversation } from "./aside-conversation"
import { AsideDrafts } from "./aside-drafts"
import { AsideSplitHandle } from "./aside-split-handle"
import { useAsideDraftSurface } from "./use-aside-draft-surface"
import { useAsideDrafts } from "./use-aside-drafts"
import { useAsideSplit } from "./use-aside-split"

interface AsidePanelProps {
  workspaceId: string
  hostStreamId: string
  className?: string
}

/**
 * The aside open on a stream, as a pane beside it (`aside:<hostStreamId>`):
 * drafts over the conversation, the divider between them dragged. Which aside
 * lives in the aside store; a pane the store holds none for shows nothing until
 * the page drops it.
 */
export function AsidePanel({ workspaceId, hostStreamId, className }: AsidePanelProps) {
  const open = useAsideState()
  useRevealReady(true)
  if (open?.hostStreamId !== hostStreamId) return null
  return (
    <AsidePanelContent
      key={open.asideId}
      workspaceId={workspaceId}
      asideId={open.asideId}
      hostStreamId={hostStreamId}
      originScope={open.originScope}
      className={className}
    />
  )
}

function AsidePanelContent({
  workspaceId,
  asideId,
  hostStreamId,
  originScope,
  className,
}: AsidePanelProps & { asideId: string; originScope: string }) {
  const { tabbed } = usePanel()
  const draftSurface = useAsideDraftSurface({ workspaceId, asideId, hostStreamId, originScope })
  // The pane stacks the drafts, the divider and the conversation with no gutters, so only the divider is furniture.
  const split = useAsideSplit(asideId, { reservedHeight: 1 })
  const streams = useWorkspaceStreams(workspaceId)
  const aside = useMemo(() => streams.find((stream) => stream.id === asideId), [streams, asideId])
  const drafts = useAsideDrafts(workspaceId, asideId)

  return (
    <SidePanel className={className} data-testid="aside-panel" data-aside-id={asideId} data-editor-zone="panel">
      <TooltipProvider delayDuration={300}>
        <PaneHeader
          workspaceId={workspaceId}
          name="Aside"
          className="gap-2.5"
          closeLabel="Close aside"
          title={
            <>
              <SidePanelTitle className="flex shrink-0 items-center gap-2.5">
                <AsideGlyph className="h-4 w-4 shrink-0 text-primary" aria-hidden />
                <span className="text-[13px] font-semibold tracking-tight">
                  <PanelTabTitle workspaceId={workspaceId} panelId={createAsidePanelId(hostStreamId)} />
                </span>
              </SidePanelTitle>
              <AsidePrivateBadge />
              <AsideAnchorLine
                workspaceId={workspaceId}
                hostStreamId={hostStreamId}
                anchorId={aside?.parentAnchorId}
                variant="chip"
              />
            </>
          }
        >
          {drafts.length > 0 && (
            <span className={ASIDE_META}>
              {drafts.length} {drafts.length === 1 ? "draft" : "drafts"}
            </span>
          )}
        </PaneHeader>
      </TooltipProvider>
      {tabbed && (
        <AsideAnchorLine workspaceId={workspaceId} hostStreamId={hostStreamId} anchorId={aside?.parentAnchorId} />
      )}
      <div ref={split.containerRef} className="flex min-h-0 flex-1 flex-col">
        <AsideDrafts
          workspaceId={workspaceId}
          asideId={asideId}
          surface={draftSurface}
          className={cn("shrink-0", !draftSurface.openScope && "border-b")}
          style={draftSurface.openScope ? { height: split.height } : undefined}
        />
        {draftSurface.openScope && <AsideSplitHandle split={split} />}
        <div className="relative min-h-0 flex-1">
          <AsideConversation
            workspaceId={workspaceId}
            asideId={asideId}
            aside={aside}
            autoFocus={!draftSurface.openScope}
            onInsertAgentBlock={draftSurface.insertAgentBlock}
          />
        </div>
      </div>
    </SidePanel>
  )
}
