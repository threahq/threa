import { useMemo } from "react"
import { useWorkspaceStreams } from "@/stores/workspace-store"
import { ASIDE_STAGE_MIN_WIDTH, type OpenAsideState } from "@/stores/aside-store"
import { MIN_MAIN_WIDTH } from "@/hooks/use-panel-layout"
import { ResizablePanelFrame } from "@/components/layout"
import { StreamContextDockProvider } from "@/components/stream-context"
import { cn } from "@/lib/utils"
import { AsideConversation } from "./aside-conversation"
import { AsideDrafts } from "./aside-drafts"
import { AsideHeader } from "./aside-header"
import { AsideSplitHandle } from "./aside-split-handle"
import { useAsideDraftSurface } from "./use-aside-draft-surface"
import { useAsideSplit } from "./use-aside-split"
import { useAsideWidth } from "./use-aside-width"

/**
 * Whether the aside has room for a column of its own beside the main column at
 * its floor and `besideWidth` of other columns; where it hasn't, it is a sheet.
 * Unmeasured (0) counts as fitting, so the first render keeps its layout.
 */
export function asideColumnFits(containerWidth: number, besideWidth: number): boolean {
  return containerWidth === 0 || containerWidth >= MIN_MAIN_WIDTH + ASIDE_STAGE_MIN_WIDTH + besideWidth
}

/**
 * Width of the aside's column at the page's right edge. It yields to nothing
 * but the main column's floor and the other columns' minimums (`reservedWidth`):
 * it is what you are working in, so the columns beside it clamp against it,
 * not the other way round. Zero while no aside is open.
 */
export function useAsideColumnLayout(aside: OpenAsideState | null, containerWidth: number, reservedWidth: number) {
  // Unmeasured, the stored width stands — capping at 0 would make the handle inert on the frame it is grabbed.
  const cap =
    containerWidth > 0 ? Math.max(ASIDE_STAGE_MIN_WIDTH, containerWidth - MIN_MAIN_WIDTH - reservedWidth) : Infinity
  const { width, ...resize } = useAsideWidth(aside?.asideId ?? "", cap)
  return { ...resize, width: aside ? width : 0, maxWidth: Number.isFinite(cap) ? cap : width }
}

type AsideColumnLayout = ReturnType<typeof useAsideColumnLayout>

/**
 * The aside as a column of the page: drafts over the conversation, the divider
 * between them dragged. The host stream is the page's own main pane beside it,
 * live, so threads open as tabs between the two and nothing is mounted twice.
 */
export function AsideColumn({
  workspaceId,
  aside: { asideId, hostStreamId, originScope },
  layout,
}: {
  workspaceId: string
  aside: OpenAsideState
  layout: AsideColumnLayout
}) {
  const draftSurface = useAsideDraftSurface({ workspaceId, asideId, hostStreamId, originScope })
  // The column stacks the drafts, the divider and the conversation with no gutters, so only the divider is furniture.
  const split = useAsideSplit(asideId, { reservedHeight: 1 })
  const streams = useWorkspaceStreams(workspaceId)
  const aside = useMemo(() => streams.find((stream) => stream.id === asideId), [streams, asideId])

  // The aside is its own stream with no overview of its own here.
  return (
    <StreamContextDockProvider value={null}>
      <ResizablePanelFrame
        panelWidth={layout.width}
        isResizing={layout.isResizing}
        minWidth={ASIDE_STAGE_MIN_WIDTH}
        maxWidth={layout.maxWidth}
        onResizeStart={layout.handleResizeStart}
        onResizeMove={layout.handleResizeMove}
        onResizeEnd={layout.handleResizeEnd}
        onResizeKeyDown={layout.onKeyDown}
        resizeLabel="Resize aside"
      >
        <div
          data-testid="aside-column"
          data-aside-id={asideId}
          data-aside-surface
          // Type-to-focus and the composer's height observer route by zone, and a zone they don't know they ignore.
          data-editor-zone="panel"
          className="flex h-full min-h-0 flex-col bg-background"
        >
          <AsideHeader workspaceId={workspaceId} asideId={asideId} hostStreamId={hostStreamId} aside={aside} />
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
        </div>
      </ResizablePanelFrame>
    </StreamContextDockProvider>
  )
}
