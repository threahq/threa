import { useCallback, useEffect, useRef, useMemo, useState, type ReactNode } from "react"
import {
  closePanelTab,
  dropPanelTab,
  floatingPanelTabs,
  panelIdsOf,
  primaryPanelOf,
  type PaneDrop,
} from "@/lib/panel-tabs"
import { usePanelLayout } from "@/hooks/use-panel-layout"
import { useElementWidth } from "@/hooks/use-element-width"
import { createAsidePanelId, parseAsidePanel, usePanel, useSidebar } from "@/contexts"
import { PanelResizeHandle, usePanelInset } from "@/components/layout"
import { AsideCoversPanesContext, AsideMobileSheet, useAsideHost, useAsideIsSheet } from "@/components/aside"
import { asidePaneOf, useAsideForHost, withoutAsidePanes, type OpenAsideState } from "@/stores/aside-store"
import {
  PagePaneContext,
  type PageContent,
  PaneDrawer,
  PanelTabStack,
  panelMaxRows,
  useFittedPanelLayout,
  useFocusGridLayout,
  useHostHeight,
  usePanelGrid,
} from "@/components/layout/panel-host"
import {
  droppedPanelSizes,
  evenPanelColumns,
  panelColumnWidths,
  panelGridShape,
  type PanelGridSizes,
} from "@/lib/panel-grid"
import { PaneHost } from "./pane-host"
import { PaneDropContext, usePaneDropState } from "./pane-drop"

interface PagePanesProps {
  workspaceId: string
  /** What the route's own `page:` pane shows, where its route pins one. */
  page?: PageContent
  /** Shown in place of the panes. */
  error?: ReactNode
}

/**
 * A route's panes: its own in the first column and the panel tabs beside it,
 * the aside as a pane or a sheet, and on a phone every pane stacked in one
 * cell with drawers over them.
 */
export function PagePanes({ workspaceId, page, error = null }: PagePanesProps) {
  const { isMobile } = useSidebar()
  const { layout } = usePanel()
  const containerRef = useRef<HTMLDivElement>(null)
  const containerWidth = useElementWidth(containerRef)
  const containerHeight = useHostHeight(containerRef)
  const maxRows = panelMaxRows(containerHeight)
  const panes = useMemo(() => panelIdsOf(layout), [layout])
  const asideHostKey = useAsideHost(panes)
  // A sheet over the page on a phone or a coarse pointer, or where no split fits; anywhere else a pane beside its stream.
  const asideIsSheet = useAsideIsSheet()
  const openAside = useAsideForHost(asideHostKey)
  useAsidePane(openAside, asideIsSheet, panes)
  const asideSheet = asideIsSheet ? openAside : null
  // A pane the sheet holds is mounted there and nowhere else (aside-mobile-sheet.tsx), and the sheet stands in for the aside's own.
  const heldPane = asideSheet !== null ? asidePaneOf(layout, asideSheet.hostStreamId, true) : null
  const pageLayout = useMemo(() => {
    const shown = asideIsSheet ? withoutAsidePanes(layout) : layout
    return heldPane === null ? shown : closePanelTab(shown, heldPane)
  }, [layout, asideIsSheet, heldPane])
  const gridLayout = useFocusGridLayout(pageLayout, isMobile)
  // Columns beside the first, which fills what they leave.
  const isPanelOpen = gridLayout.columns.length > 1
  // A phone's pages, without the drawers over them, and the one on show.
  const phonePages = useFittedPanelLayout(pageLayout, 1, true)
  const shownPage = primaryPanelOf(phonePages)
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
    sizePanel,
    maxColumns,
  } = usePanelLayout(isPanelOpen, {
    containerRef,
    columns: gridLayout.columns.length - 1,
    animates: !isMobile,
  })
  const fittedPanels = useFittedPanelLayout(gridLayout, maxColumns + 1, false, maxRows)
  // A phone stacks every pane in the one cell.
  const display = isMobile ? phonePages : fittedPanels
  const panelGrid = usePanelGrid(display, gridLayout)
  const columnWidths = useMemo(
    () => (displayWidth > 0 ? panelColumnWidths(panelGrid.sizes.columns.slice(1), displayWidth) : []),
    [panelGrid.sizes.columns, displayWidth]
  )

  // A pane dropped on an edge opens at the size its zone showed, once the arrangement it made is on show.
  const [dropped, setDropped] = useState<{ before: string; after: string; sizes: PanelGridSizes } | null>(null)
  const arrangement = JSON.stringify(gridLayout.columns)
  if (dropped !== null && arrangement !== dropped.before) {
    setDropped(null)
    if (arrangement === dropped.after) {
      panelGrid.setSizes(dropped.sizes)
      sizePanel(sum(dropped.sizes.columns.slice(1)), dropped.sizes.columns.length - 1)
    }
  }
  const sizeDrop = useCallback(
    (panelId: string, drop: PaneDrop) => {
      const after = dropPanelTab(gridLayout, panelId, drop)
      // A folded arrangement shows other panes than the zone measured, or than the drop makes.
      const folds =
        panelGridShape(gridLayout) !== panelGridShape(display) ||
        after.columns.length > maxColumns + 1 ||
        after.columns.some((sections) => sections.length > maxRows)
      if (drop.kind !== "edge" || folds) return
      const widths = [Math.max(0, containerWidth - displayWidth), ...columnWidths]
      setDropped({
        before: JSON.stringify(gridLayout.columns),
        after: JSON.stringify(after.columns),
        sizes: droppedPanelSizes(display, widths, panelGrid.sizes.rows, after, panelId, drop.side),
      })
    },
    [gridLayout, display, maxColumns, maxRows, containerWidth, displayWidth, columnWidths, panelGrid.sizes.rows]
  )
  const paneDrops = usePaneDropState(workspaceId, sizeDrop)

  // Above the error return: a stream that turns inaccessible mid-session must not change the hook count.
  usePanelInset(isMobile || error ? 0 : displayWidth, shouldAnimate)

  if (error) return error

  // A tab floating over the page leaves everything else under it out of reach.
  const floating = floatingPanelTabs(pageLayout, isMobile).length > 0

  const drops = isMobile || floating || heldPane !== null ? null : paneDrops
  // A track for every column that fits, so opening, closing or resizing one animates from the width it had.
  const panelTracks = Array.from({ length: maxColumns }, (_, column) => columnWidths[column] ?? 0)
  const columns = isMobile ? "minmax(0,1fr)" : ["minmax(0,1fr)", ...panelTracks.map((width) => `${width}px`)].join(" ")

  return (
    <PagePaneContext.Provider value={page ?? null}>
      <AsideCoversPanesContext.Provider value={asideSheet !== null}>
        <PaneHost
          ref={containerRef}
          columns={columns}
          rows={panelGrid.rows || "minmax(0,1fr)"}
          animate={shouldAnimate && !isMobile}
          onTransitionEnd={handleTransitionEnd}
        >
          {/* Drops reach the page's own panes only: never a drawer's. */}
          <PaneDropContext.Provider value={drops}>
            <PanelTabStack
              workspaceId={workspaceId}
              maxColumns={maxColumns + 1}
              maxRows={maxRows}
              stacked={isMobile}
              layout={pageLayout}
              display={display}
              grid={panelGrid}
              width={isMobile ? null : panelWidth}
              firstColumnWidth={Math.max(0, containerWidth - displayWidth)}
              height={containerHeight}
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
          {/* One drawer at a time: the aside's sheet holds the page under the overview's. */}
          {isMobile && !asideSheet && <PaneDrawer workspaceId={workspaceId} page={shownPage} />}
          {asideSheet && (
            <AsideMobileSheet
              workspaceId={workspaceId}
              asideId={asideSheet.asideId}
              hostStreamId={asideSheet.hostStreamId}
              originScope={asideSheet.originScope}
            />
          )}
        </PaneHost>
      </AsideCoversPanesContext.Provider>
    </PagePaneContext.Provider>
  )
}

/**
 * Keeps the aside's pane in step with the open aside: opened beside its stream
 * once per aside, and any `aside:` pane the store holds no aside for (closed,
 * replaced, or arrived by reload or shared link) dropped.
 */
function useAsidePane(aside: OpenAsideState | null, isSheet: boolean, panes: readonly string[]) {
  const { openPanel, closeTabs } = usePanel()
  const placed = useRef<string | null>(null)
  const dropping = useRef<readonly string[]>([])
  useEffect(() => {
    const stale = panes.filter((pane) => {
      const host = parseAsidePanel(pane)
      return host !== null && host !== aside?.hostStreamId
    })
    // A close can pop history, so asking twice before the route catches up would pop two entries.
    if (stale.length > 0 && stale.join() !== dropping.current.join()) closeTabs(stale)
    dropping.current = stale
    if (stale.length > 0) return
    if (aside === null) placed.current = null
    // Placed once: a pane the user closes takes the aside with it, so it never reopens itself.
    if (aside === null || isSheet || placed.current === aside.asideId) return
    placed.current = aside.asideId
    const pane = createAsidePanelId(aside.hostStreamId)
    if (!panes.includes(pane)) openPanel(pane, { beside: aside.hostStreamId })
  }, [aside, isSheet, panes, openPanel, closeTabs])
}

const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0)
