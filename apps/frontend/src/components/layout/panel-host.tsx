import { memo, useCallback, useEffect, useMemo, useState, type RefObject } from "react"
import {
  usePanel,
  useCurrentPane,
  isConversationPanel,
  parseComposePanel,
  parseContextPanel,
  paneIdentity,
  PaneScope,
  DisplayedPanelLayoutProvider,
  PhonePanesProvider,
  InPaneDrawerProvider,
  presentsAsDrawer,
  coverPaneOf,
} from "@/contexts"
import { Minimize2 } from "lucide-react"
import {
  Pane,
  PaneDropIndicator,
  PaneFocusContext,
  PanelTabTitle,
  paneDropZone,
  usePaneDrop,
  usePaneFocusEscape,
  type PaneMapCell,
} from "@/components/panes"
import { useResizeDrag } from "@/hooks/use-resize-drag"
import {
  compilePanelGrid,
  defaultPanelGridSizes,
  panelColumnWidths,
  panelGridShape,
  resplit,
  type PanelGridSizes,
} from "@/lib/panel-grid"
import { Drawer, DrawerContent, DrawerDescription, DrawerTitle } from "@/components/ui/drawer"
import {
  closePanelTab,
  firstColumnHolds,
  fitPanelLayout,
  floatingPanelTab,
  panelIdsOf,
  type PaneEdge,
  type PanelLayout,
  type PanelSection,
  type SplitDirection,
} from "@/lib/panel-tabs"
import { cn } from "@/lib/utils"
import { PanelResizeHandle } from "./panel-resize-handle"
import { PaneShortcuts } from "./pane-shortcuts"
import { getDraftPromotionSource } from "@/lib/draft-promotions"
import { StreamPanel } from "@/components/thread"
import { ConversationPanel } from "@/components/conversations/conversation-panel"
import { ComposePanel } from "@/components/composer/compose-panel"
import { StreamContextPane } from "@/components/stream-context"

/**
 * A draft thread promoted to its real stream keeps the draft's key, so its pane
 * survives the handoff; an overview keeps one key across its filters.
 */
function panelKeyFor(workspaceId: string, panelId: string): string {
  return getDraftPromotionSource(workspaceId, panelId) ?? paneIdentity(panelId)
}

interface PanelHostProps {
  workspaceId: string
  onClose: () => void
  className?: string
}

/**
 * Picks the side panel's content by panel kind: a `conv:<id>` panel opens a
 * conversation projection (Mechanism B), a `compose:<id>` panel a stream's
 * draft, a `context:<id>` panel a stream's overview, every other id is a stream/thread/draft
 * handled by {@link StreamPanel}. Both stream.tsx and board.tsx host the panel
 * through this, so either surface can open either kind. Keyed on the panel id so
 * switching targets remounts cleanly — except a draft thread promoted to its real
 * stream, which keeps the draft's key so the panel carries its state across the
 * handoff instead of remounting. Hosts must not key this element themselves: an
 * outer `key={panelId}` unmounts the whole host on promotion, before the key
 * below can preserve anything.
 */
export function PanelHost({ workspaceId, onClose, className }: PanelHostProps) {
  const { panelId } = usePanel()
  const composeStreamId = panelId && parseComposePanel(panelId)
  const context = panelId && parseContextPanel(panelId)
  if (panelId && isConversationPanel(panelId)) {
    return <ConversationPanel key={panelId} workspaceId={workspaceId} onClose={onClose} className={className} />
  }
  if (composeStreamId) {
    return (
      <ComposePanel
        key={panelId}
        workspaceId={workspaceId}
        streamId={composeStreamId}
        onClose={onClose}
        className={className}
      />
    )
  }
  if (context) {
    return (
      <StreamContextPane
        key={panelKeyFor(workspaceId, panelId)}
        workspaceId={workspaceId}
        streamId={context.streamId}
        filter={context.filter}
        onClose={onClose}
        className={className}
      />
    )
  }
  return (
    <StreamPanel
      key={panelId ? panelKeyFor(workspaceId, panelId) : panelId}
      workspaceId={workspaceId}
      onClose={onClose}
      className={className}
    />
  )
}

const MIN_SECTION_WIDTH = 200
const MIN_SECTION_HEIGHT = 120

const NO_SPLITS: readonly SplitDirection[] = []
const NO_MAP: readonly PaneMapCell[] = []
const SPLIT_DOWN: readonly SplitDirection[] = ["down"]
const SPLIT_ANY: readonly SplitDirection[] = ["right", "down"]
const EDGES_ANY: readonly PaneEdge[] = ["left", "right", "top", "bottom"]
const EDGES_ROW: readonly PaneEdge[] = ["top", "bottom"]
const NO_EDGES: readonly PaneEdge[] = []

interface PanelTabStackProps {
  workspaceId: string
  /** How many of the arrangement's columns fit side by side; the rest fold into the last. */
  maxColumns: number
  /** Show every tab in one section (a phone). */
  stacked: boolean
  /** The tabs on show, from {@link useFittedPanelLayout}, placed on the page's grid by {@link usePanelGrid}. */
  display: PanelLayout
  grid: PanelGridState
  /** Pixels the columns after the first share, or null where every tab fills the page (a phone). */
  width: number | null
  /** Pixels the first column fills, which a floating tab's map shows too. */
  firstColumnWidth: number
  /** The page's grid, whose height the sections share. */
  host: RefObject<HTMLElement | null>
}

interface PlacedTab {
  key: string
  id: string
  area: string
  /** Its column's width, held while the column's track opens or closes so the tab lays out once; the first column fills its track. */
  width: number | null
  inFirstColumn: boolean
  section: PanelSection
  splits: readonly SplitDirection[]
}

type PanelGridState = ReturnType<typeof usePanelGrid>

/** The page's grid for `display`: its row tracks, each section's area, and the column shares as last dragged. */
export function usePanelGrid(display: PanelLayout) {
  const [sizes, setSizes] = usePanelGridSizes(display)
  const { rows, areas } = useMemo(() => compilePanelGrid(sizes), [sizes])
  return { sizes, setSizes, rows, areas }
}

/** `layout` as a window `maxColumns` wide arranges it, or a phone when `stacked`. */
export function useFittedPanelLayout(layout: PanelLayout, maxColumns: number, stacked: boolean): PanelLayout {
  const current = useCurrentPane()
  // Working in the first column leaves a folded section showing the pane last worked in outside it.
  const [lastPanel, setLastPanel] = useState(current)
  if (current !== null && current !== lastPanel && !firstColumnHolds(layout, current)) setLastPanel(current)
  return useMemo(() => {
    // A floating tab is always on show, even from a folded column.
    if (!stacked) return fitPanelLayout(layout, maxColumns, false, layout.focused ?? current, lastPanel)
    // A phone shows a drawer over a page, so the page is on show behind it.
    const pages = panelIdsOf(layout).filter(presentsAsDrawer).reduce(closePanelTab, layout)
    const shown = current !== null && presentsAsDrawer(current) ? pageUnder(layout, current) : current
    return fitPanelLayout(pages, maxColumns, true, shown)
  }, [layout, maxColumns, stacked, current, lastPanel])
}

/** The page a drawer pane sits over: its stream's, else the first page. */
function pageUnder(layout: PanelLayout, drawer: string): string | null {
  const cover = coverPaneOf(layout, drawer)
  if (cover !== drawer) return cover
  return panelIdsOf(layout).find((id) => !presentsAsDrawer(id)) ?? null
}

/** The drawer pane over `page` (null for none), when one is open. */
function drawerOver(layout: PanelLayout, page: string | null): string | null {
  return panelIdsOf(layout).find((id) => presentsAsDrawer(id) && pageUnder(layout, id) === page) ?? null
}

/**
 * A pane that can't sit beside its stream (a phone, the board) as a bottom
 * drawer over the page showing that stream. Its id stays in `?panel=`, so Back
 * closes and reopens it like any pane; the last one shown stays rendered while
 * the drawer animates out.
 */
export function PaneDrawer({ workspaceId, page }: { workspaceId: string; page: string | null }) {
  const { layout, closeTab } = usePanel()
  const id = drawerOver(layout, page)
  const [shown, setShown] = useState(id)
  if (id !== null && id !== shown) setShown(id)
  const section = useMemo(() => (shown ? { ids: [shown], active: shown } : null), [shown])

  return (
    // The URL is its history entry: opening pushed `?panel=`, so Back already closes it.
    <Drawer open={id !== null} onOpenChange={(open) => !open && id && closeTab(id)} historyEntry={false}>
      <DrawerContent className="h-[88dvh] md:mx-auto md:max-w-2xl">
        <DrawerTitle className="sr-only">In this stream</DrawerTitle>
        <DrawerDescription className="sr-only">
          Links, files, images, captured memories, and delegated tasks from this conversation.
        </DrawerDescription>
        {shown && section && (
          <div className="flex min-h-0 flex-1 flex-col">
            <InPaneDrawerProvider value>
              <PaneScope panelId={shown} section={section} splits={NO_SPLITS}>
                <ScopedPanelHost workspaceId={workspaceId} />
              </PaneScope>
            </InPaneDrawerProvider>
          </div>
        )}
      </DrawerContent>
    </Drawer>
  )
}

/**
 * Every open panel tab as a flat child of one grid: each section's tabs stack
 * in its cell, the active one shows and the rest stay mounted under it, so
 * switching tabs keeps each one's scroll and draft and a split never re-parents
 * a tab. Tabs are keyed the way {@link PanelHost} keys its content, so a draft
 * promoted in its tab keeps its pane. They render in key order with `grid-area`
 * placing them, because moving a mounted element in the DOM resets its scroll;
 * focus order can differ from the visual order as a result.
 */
export function PanelTabStack({
  workspaceId,
  maxColumns,
  stacked,
  display,
  grid,
  width,
  firstColumnWidth,
  host,
}: PanelTabStackProps) {
  const { layout, setCurrentPane, focusTab } = usePanel()
  const current = useCurrentPane()
  const { sizes, setSizes, areas } = grid
  const height = useHostHeight(host)
  const panelShares = sizes.columns.slice(1)
  const columnWidths = width === null ? null : panelColumnWidths(panelShares, width)

  // A folded section shows more than its own tabs, so a split from it would move a tab it doesn't hold.
  const folded = display !== layout
  const splitsOf = (section: PanelSection) => {
    if (folded || section.ids.length < 2) return NO_SPLITS
    return layout.columns.length < maxColumns ? SPLIT_ANY : SPLIT_DOWN
  }
  const splitEdges = layout.columns.length < maxColumns ? EDGES_ANY : EDGES_ROW
  // Dropped beside a folded section, a tab would land in a column that doesn't show.
  const edges = folded ? NO_EDGES : splitEdges
  const drops = usePaneDrop()
  const tabs: PlacedTab[] = display.columns
    .flatMap((sections, column) =>
      sections.flatMap((section, row) => {
        const splits = splitsOf(section)
        return section.ids.map((id) => ({
          key: panelKeyFor(workspaceId, id),
          id,
          area: areas[column][row],
          width: column === 0 ? null : (columnWidths?.[column - 1] ?? null),
          inFirstColumn: firstColumnHolds(layout, id),
          section,
          splits,
        }))
      })
    )
    .sort((a, b) => (a.key < b.key ? -1 : 1))

  const sections = display.columns.flat()
  const orderKey = sections.flatMap((section) => section.ids).join(".")
  const phonePanes = useMemo(
    () => (stacked ? { order: orderKey.split("."), current } : null),
    [stacked, orderKey, current]
  )
  // The pane worked in, else the first on show.
  const shownSection = sections.find((section) => section.active === current) ?? sections[0]
  const panes = stacked ? undefined : sections.map((section) => section.active)

  const focused = floatingPanelTab(layout, stacked)
  const firstShare = firstColumnWidth + (width ?? 0) > 0 ? firstColumnWidth / (firstColumnWidth + (width ?? 0)) : 1
  const restore = useCallback(() => focusTab(null), [focusTab])
  usePaneFocusEscape(focused, restore)
  // Only Restore draws the map, so resizing with nothing floating leaves every pane's header alone.
  const map = useMemo(
    () => (focused === null ? NO_MAP : paneMap(display, sizes, focused, firstShare)),
    [focused, display, sizes, firstShare]
  )
  const focus = useMemo(() => (stacked ? null : { focused, map }), [stacked, focused, map])
  const ghost = tabs.find((tab) => tab.id === focused)

  // The first column fills what the rest leave, so only the dividers between the rest share sizes.
  const columnUnit = (width ?? 0) / sum(panelShares)
  const columnResizers = panelShares
    .slice(1)
    .map((share, index) => (
      <SectionResizer
        key={`column:${index}`}
        axis="x"
        area={`1 / ${index + 3} / -1 / ${index + 4}`}
        size={panelShares[index] * columnUnit}
        span={(panelShares[index] + share) * columnUnit}
        min={MIN_SECTION_WIDTH}
        onResize={(px) => setSizes({ ...sizes, columns: resplit(sizes.columns, index + 1, px / columnUnit) })}
      />
    ))
  const rowResizers = sizes.rows.flatMap((rows, column) => {
    const unit = height / sum(rows)
    return rows.slice(1).map((share, index) => (
      <SectionResizer
        key={`row:${column}:${index}`}
        axis="y"
        area={areas[column][index + 1]}
        size={rows[index] * unit}
        span={(rows[index] + share) * unit}
        min={MIN_SECTION_HEIGHT}
        onResize={(px) =>
          setSizes({
            ...sizes,
            rows: sizes.rows.map((shares, at) => (at === column ? resplit(shares, index, px / unit) : shares)),
          })
        }
      />
    ))
  })

  return (
    <PhonePanesProvider value={phonePanes}>
      <PaneFocusContext.Provider value={focus}>
        <DisplayedPanelLayoutProvider value={display}>
          {tabs.map((tab) => (
            <Pane
              key={tab.key}
              // Out of its cell, so it floats over the whole page: an absolute grid child sits in its own area.
              area={tab.id === focused ? "auto" : tab.area}
              covered={tab.id !== tab.section.active}
              // Focus mode is a class on the same pane, never a dialog: a portal would remount it and lose its draft and scroll.
              inert={focused !== null && tab.id !== focused}
              className={cn(
                "bg-background",
                tab.id === focused &&
                  "absolute inset-x-5 top-[58px] bottom-5 z-30 rounded-[10px] border shadow-[0_24px_60px_rgba(0,0,0,0.28)]",
                focused !== null && tab.id !== focused && "isolate"
              )}
              data-testid={tab.inFirstColumn ? "main-pane" : "panel"}
              data-panel-tab={tab.id}
              data-front-panel={tab.id === current || undefined}
              data-focused-pane={tab.id === focused || undefined}
              // A pressed pane becomes the route's once the click lands: the route's stream shows chrome the
              // others don't, which would shift a header button or fold a tab out from under the pointer.
              onClickCapture={() => setCurrentPane(tab.id)}
              onFocusCapture={(event) => {
                if (event.target.matches(":focus-visible")) setCurrentPane(tab.id)
              }}
              {...paneDropZone(drops, tab.id, edges)}
            >
              <div className="h-full" style={{ width: tab.id === focused ? undefined : (tab.width ?? undefined) }}>
                <PaneScope panelId={tab.id} section={tab.section} splits={tab.splits}>
                  <ScopedPanelHost workspaceId={workspaceId} />
                </PaneScope>
              </div>
            </Pane>
          ))}
        </DisplayedPanelLayoutProvider>
      </PaneFocusContext.Provider>
      {display.columns.map((sections, column) =>
        sections.map((section, row) => (
          <PaneDropIndicator key={`${column}:${row}`} of={section.active} area={areas[column][row]} />
        ))
      )}
      {ghost && (
        <div
          aria-hidden
          data-testid="pane-focus-ghost"
          style={{ gridArea: ghost.area }}
          className="grid min-h-0 min-w-0 place-items-center bg-background bg-[repeating-linear-gradient(135deg,transparent_0_10px,hsl(0_0%_50%/0.05)_10px_20px)] text-sm text-muted-foreground"
        >
          <div className="flex max-w-[80%] items-center gap-2 rounded-lg border border-dashed px-3 py-2">
            <span className="truncate">
              <PanelTabTitle workspaceId={workspaceId} panelId={ghost.id} />
            </span>
            <Minimize2 className="h-4 w-4 shrink-0" />
          </div>
        </div>
      )}
      {focused !== null && (
        // Spans the whole page, top band included: the tab bars along the top stay in sight, and a click on them puts the pane back.
        <div
          data-testid="pane-focus-scrim"
          className="absolute inset-0 z-[29] bg-[rgba(30,20,10,0.22)] bg-clip-content pt-12 dark:bg-black/55"
          onClick={restore}
        />
      )}
      {/* Under a floating tab they would still take Tab and the arrow keys. */}
      {focused === null && columnResizers}
      {focused === null && rowResizers}
      {shownSection?.active && (
        <PaneScope panelId={shownSection.active} section={shownSection} splits={NO_SPLITS}>
          <PaneShortcuts panes={panes} />
        </PaneScope>
      )}
    </PhonePanesProvider>
  )
}

const sum = (shares: readonly number[]) => shares.reduce((total, share) => total + share, 0)

/** Each section on show: the first column at `firstShare` of the width, the rest by their shares of what is left. */
function paneMap(
  display: PanelLayout,
  sizes: PanelGridSizes,
  focused: string | null,
  firstShare: number
): PaneMapCell[] {
  const rest = sum(sizes.columns.slice(1))
  const left = (column: number) =>
    column === 0 ? 0 : firstShare + ((1 - firstShare) * sum(sizes.columns.slice(1, column))) / rest
  return display.columns.flatMap((sections, column) => {
    const rows = sizes.rows[column]
    const height = sum(rows)
    const width = column === 0 ? firstShare : ((1 - firstShare) * sizes.columns[column]) / rest
    return sections.map((section, row) => ({
      x: left(column),
      y: sum(rows.slice(0, row)) / height,
      width,
      height: rows[row] / height,
      focused: section.active === focused,
    }))
  })
}

/** Section sizes last dragged for this arrangement's shape, so undoing a split finds the old sizes again. */
function usePanelGridSizes(display: PanelLayout) {
  const [stored, setStored] = useState<Record<string, PanelGridSizes>>({})
  const shape = panelGridShape(display)
  const setSizes = useCallback(
    (next: PanelGridSizes) => setStored((current) => ({ ...current, [shape]: next })),
    [shape]
  )
  const fallback = useMemo(() => defaultPanelGridSizes(display), [display])
  return [stored[shape] ?? fallback, setSizes] as const
}

/**
 * The page grid's height, measured after commit: an ancestor's ref is attached
 * only after this component's layout effects have run.
 */
function useHostHeight(host: RefObject<HTMLElement | null>) {
  const [height, setHeight] = useState(0)
  useEffect(() => {
    const element = host.current
    if (!element) return
    const measure = () => setHeight(element.clientHeight)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [host])
  return height
}

interface SectionResizerProps {
  axis: "x" | "y"
  /** The trailing section's area: the divider is its leading edge, as a border would be. */
  area: string
  /** Pixel size of the section before the divider. */
  size: number
  /** Pixel size of the sections either side of the divider together. */
  span: number
  min: number
  onResize: (size: number) => void
}

/** The divider between two sections, dragged or arrow-keyed like the panel's own edge. */
function SectionResizer({ axis, area, size, span, min, onResize }: SectionResizerProps) {
  // Sections squeezed below twice the minimum share what there is, rather than the leading one snapping to it.
  const floor = Math.min(min, span / 2)
  const max = span - floor
  const clamp = useCallback((next: number) => Math.max(floor, Math.min(max, next)), [floor, max])
  const resize = useCallback((next: number) => onResize(clamp(next)), [onResize, clamp])
  // Sizes kept from a wider window can sit outside what fits now; drag and step from what shows.
  const shown = clamp(size)
  const { isResizing, handleResizeStart, handleResizeMove, handleResizeEnd } = useResizeDrag({
    width: shown,
    onWidthChange: resize,
    direction: axis === "x" ? "right" : "down",
  })
  const [shrinkKey, growKey] = axis === "x" ? ["ArrowLeft", "ArrowRight"] : ["ArrowUp", "ArrowDown"]
  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== shrinkKey && event.key !== growKey) return
    event.preventDefault()
    const step = event.shiftKey ? 50 : 10
    resize(event.key === growKey ? shown + step : shown - step)
  }
  return (
    <PanelResizeHandle
      axis={axis}
      style={{ gridArea: area }}
      className={cn("z-10", axis === "x" ? "justify-self-start" : "self-start")}
      isResizing={isResizing}
      panelWidth={Math.round(shown)}
      minWidth={Math.round(floor)}
      maxWidth={Math.round(max)}
      onPointerDown={handleResizeStart}
      onPointerMove={handleResizeMove}
      onPointerEnd={handleResizeEnd}
      onKeyDown={handleKeyDown}
      ariaLabel={axis === "x" ? "Resize panels side by side" : "Resize stacked panels"}
    />
  )
}

const ScopedPanelHost = memo(function ScopedPanelHost({ workspaceId }: { workspaceId: string }) {
  const { closePanel } = usePanel()
  return <PanelHost workspaceId={workspaceId} onClose={closePanel} />
})
