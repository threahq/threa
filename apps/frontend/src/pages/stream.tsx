import { useRef, useEffect, useMemo } from "react"
import { useParams } from "react-router-dom"
import { cn } from "@/lib/utils"
import { closePanelTab, floatingPanelTab, panelIdsOf, primaryPanelOf } from "@/lib/panel-tabs"
import { useStreamOrDraft, useStreamError, usePanelLayout, useTypeToFocus } from "@/hooks"
import { usePanel, useSidebar } from "@/contexts"
import { PanelResizeHandle, usePanelInset } from "@/components/layout"
import { PaneHost, Pane, PaneDropContext, usePaneDropState } from "@/components/panes"
import {
  AsideColumn,
  AsideCoversPanesContext,
  AsideMobileSheet,
  asideColumnFits,
  useAsideColumnLayout,
  useAsideHost,
  useAsideIsSheet,
} from "@/components/aside"
import { asidePaneOf, useAsideForHost } from "@/stores/aside-store"
import { PaneDrawer, PanelTabStack, useFittedPanelLayout, usePanelGrid } from "@/components/layout/panel-host"
import { StreamErrorView } from "@/components/stream-error-view"
import { getStreamName } from "@/lib/streams"
import { MIN_PANEL_WIDTH } from "@/hooks/use-panel-layout"
import { useElementWidth } from "@/hooks/use-element-width"
import { setPageStreamName } from "@/lib/page-title"
import { panelColumnWidths } from "@/lib/panel-grid"

export function StreamPage() {
  const { workspaceId, streamId } = useParams<{ workspaceId: string; streamId: string }>()
  const { stream, error } = useStreamOrDraft(workspaceId!, streamId!)
  const { isMobile } = useSidebar()
  const { layout } = usePanel()
  const containerRef = useRef<HTMLDivElement>(null)
  const containerWidth = useElementWidth(containerRef)
  const panes = useMemo(() => panelIdsOf(layout), [layout])
  const asideHostKey = useAsideHost(panes)
  // A sheet over the page on a phone, or where the columns leave it no room; anywhere else a column of it.
  const asideSheetOnly = useAsideIsSheet()
  const asideIsSheet =
    asideSheetOnly || !asideColumnFits(containerWidth, layout.columns.length > 1 ? MIN_PANEL_WIDTH : 0)
  const openAside = useAsideForHost(asideHostKey)
  const asideColumn = asideIsSheet ? null : openAside
  // A pane the sheet holds is mounted there and nowhere else (aside-mobile-sheet.tsx).
  const heldPane = asideIsSheet && openAside !== null ? asidePaneOf(layout, openAside.hostStreamId, true) : null
  const pageLayout = useMemo(() => (heldPane === null ? layout : closePanelTab(layout, heldPane)), [layout, heldPane])
  // Columns beside the first, which fills what they leave.
  const isPanelOpen = pageLayout.columns.length > 1
  // A phone's pages, without the drawers over them, and the one on show.
  const phonePages = useFittedPanelLayout(pageLayout, 1, true)
  const page = primaryPanelOf(phonePages)
  // The aside clamps against the other columns' minimums.
  const asideLayout = useAsideColumnLayout(asideColumn, containerWidth, isPanelOpen ? MIN_PANEL_WIDTH : 0)
  const {
    panelWidth,
    maxWidth,
    minWidth,
    displayWidth,
    shouldAnimate,
    isResizing,
    showContent,
    handleResizeStart,
    handleResizeMove,
    handleResizeEnd,
    handleResizeKeyDown,
    handleTransitionEnd,
    maxColumns,
  } = usePanelLayout(isPanelOpen, {
    containerRef,
    columns: pageLayout.columns.length - 1,
    reservedWidth: asideLayout.width,
    animates: !isMobile,
  })
  const fittedPanels = useFittedPanelLayout(pageLayout, maxColumns + 1, false)
  // A phone stacks every pane in the one cell.
  const display = isMobile ? phonePages : fittedPanels
  const panelGrid = usePanelGrid(display)
  const paneDrops = usePaneDropState(workspaceId!)

  useTypeToFocus()

  // Unified error checking - checks both coordinated loading and direct query errors. Beside other panes,
  // the stream's own pane shows its error and the rest stay usable.
  const streamError = useStreamError(streamId, error)
  const pageError = panes.length === 1 ? streamError : null

  const panelInset = displayWidth + asideLayout.width
  const panelInsetAnimates = shouldAnimate && !asideLayout.isResizing
  // Above the error/early returns: a stream that turns inaccessible mid-session
  // must not change this component's hook count.
  usePanelInset(isMobile || pageError ? 0 : panelInset, panelInsetAnimates)

  // `stream.displayName` is already viewer-resolved by useStreamOrDraft (DM peer
  // names included), so the page title just reads the shared name off it.
  useEffect(() => {
    if (!stream) {
      setPageStreamName(null)
      return () => setPageStreamName(null)
    }
    setPageStreamName(getStreamName(stream))
    return () => setPageStreamName(null)
  }, [stream])

  if (!workspaceId || !streamId) {
    return null
  }

  // Show error page if stream has error (404/403)
  if (pageError) {
    return <StreamErrorView type={pageError.type} workspaceId={workspaceId} />
  }

  // A tab floating over the page leaves everything else under it out of reach.
  const floating = floatingPanelTab(layout, isMobile) !== null

  const drops = isMobile || floating || heldPane !== null ? null : paneDrops
  // A track for every column that fits, so opening, closing or resizing one animates from the width it had.
  const columnWidths = displayWidth > 0 ? panelColumnWidths(panelGrid.sizes.columns.slice(1), displayWidth) : []
  const panelTracks = Array.from({ length: maxColumns }, (_, column) => columnWidths[column] ?? 0)
  const columns = isMobile
    ? "minmax(0,1fr)"
    : ["minmax(0,1fr)", ...panelTracks.map((width) => `${width}px`), `${asideLayout.width}px`].join(" ")

  return (
    <AsideCoversPanesContext.Provider value={asideIsSheet && openAside !== null}>
      <PaneHost
        ref={containerRef}
        columns={columns}
        rows={panelGrid.rows || "minmax(0,1fr)"}
        animate={shouldAnimate && !isMobile && !asideLayout.isResizing}
        onTransitionEnd={handleTransitionEnd}
      >
        {/* Drops reach the page's own panes only: never the aside's, nor a drawer's. */}
        <PaneDropContext.Provider value={drops}>
          <PanelTabStack
            workspaceId={workspaceId}
            maxColumns={maxColumns + 1}
            stacked={isMobile}
            display={display}
            grid={panelGrid}
            width={isMobile ? null : panelWidth}
            firstColumnWidth={Math.max(0, containerWidth - displayWidth - asideLayout.width)}
            host={containerRef}
          />
          {showContent && isPanelOpen && !isMobile && (
            <PanelResizeHandle
              style={{ gridArea: "1 / 2 / -1 / 3" }}
              className="z-10 justify-self-start"
              isResizing={isResizing}
              panelWidth={panelWidth}
              minWidth={minWidth}
              maxWidth={maxWidth}
              onPointerDown={handleResizeStart}
              onPointerMove={handleResizeMove}
              onPointerEnd={handleResizeEnd}
              onKeyDown={handleResizeKeyDown}
              inert={floating}
            />
          )}
        </PaneDropContext.Provider>
        {asideColumn && (
          <Pane area="1 / -2 / -1 / -1" inert={floating} className={cn(floating && "isolate")}>
            <AsideColumn workspaceId={workspaceId} aside={asideColumn} layout={asideLayout} />
          </Pane>
        )}
        {/* One drawer at a time: the aside's sheet holds the page under the overview's. */}
        {isMobile && !(asideIsSheet && openAside) && <PaneDrawer workspaceId={workspaceId} page={page} />}
        {asideIsSheet && openAside && (
          <AsideMobileSheet
            workspaceId={workspaceId}
            asideId={openAside.asideId}
            hostStreamId={openAside.hostStreamId}
            originScope={openAside.originScope}
            historyEntry={asideSheetOnly}
          />
        )}
      </PaneHost>
    </AsideCoversPanesContext.Provider>
  )
}
