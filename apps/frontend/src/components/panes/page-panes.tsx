import { useRef, useMemo, type ReactNode } from "react"
import { cn } from "@/lib/utils"
import { closePanelTab, floatingPanelTab, panelIdsOf, primaryPanelOf } from "@/lib/panel-tabs"
import { usePanelLayout, MIN_PANEL_WIDTH } from "@/hooks/use-panel-layout"
import { useElementWidth } from "@/hooks/use-element-width"
import { usePanel, useSidebar } from "@/contexts"
import { PanelResizeHandle, usePanelInset } from "@/components/layout"
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
import {
  PagePaneContext,
  PaneDrawer,
  PanelTabStack,
  useFittedPanelLayout,
  usePanelGrid,
} from "@/components/layout/panel-host"
import { evenPanelColumns, panelColumnWidths } from "@/lib/panel-grid"
import { PaneHost, Pane } from "./pane-host"
import { PaneDropContext, usePaneDropState } from "./pane-drop"

interface PagePanesProps {
  workspaceId: string
  /** What the route's own `page:` pane shows, where its route pins one. */
  page?: ReactNode
  /** Shown in place of the panes. */
  error?: ReactNode
}

/**
 * A route's panes: its own in the first column and the panel tabs beside it,
 * the aside as a column or a sheet, and on a phone every pane stacked in one
 * cell with drawers over them.
 */
export function PagePanes({ workspaceId, page = null, error = null }: PagePanesProps) {
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
  const asideSheet = asideIsSheet ? openAside : null
  // A pane the sheet holds is mounted there and nowhere else (aside-mobile-sheet.tsx).
  const heldPane = asideSheet !== null ? asidePaneOf(layout, asideSheet.hostStreamId, true) : null
  const pageLayout = useMemo(() => (heldPane === null ? layout : closePanelTab(layout, heldPane)), [layout, heldPane])
  // Columns beside the first, which fills what they leave.
  const isPanelOpen = pageLayout.columns.length > 1
  // A phone's pages, without the drawers over them, and the one on show.
  const phonePages = useFittedPanelLayout(pageLayout, 1, true)
  const shownPage = primaryPanelOf(phonePages)
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
    handleResizeReset,
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
  const paneDrops = usePaneDropState(workspaceId)

  const panelInset = displayWidth + asideLayout.width
  const panelInsetAnimates = shouldAnimate && !asideLayout.isResizing
  // Above the error return: a stream that turns inaccessible mid-session must not change the hook count.
  usePanelInset(isMobile || error ? 0 : panelInset, panelInsetAnimates)

  if (error) return error

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
    <PagePaneContext.Provider value={page}>
      <AsideCoversPanesContext.Provider value={asideSheet !== null}>
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
                onReset={() => {
                  handleResizeReset()
                  panelGrid.setSizes(evenPanelColumns(panelGrid.sizes))
                }}
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
          {isMobile && !asideSheet && <PaneDrawer workspaceId={workspaceId} page={shownPage} />}
          {asideSheet && (
            <AsideMobileSheet
              workspaceId={workspaceId}
              asideId={asideSheet.asideId}
              hostStreamId={asideSheet.hostStreamId}
              originScope={asideSheet.originScope}
              historyEntry={asideSheetOnly}
            />
          )}
        </PaneHost>
      </AsideCoversPanesContext.Provider>
    </PagePaneContext.Provider>
  )
}
