import {
  createContext,
  memo,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react"
import {
  usePanel,
  useCurrentPane,
  isConversationPanel,
  parseAsidePanel,
  parseComposePanel,
  parseConversationsPanel,
  parsePersonaTestPanel,
  parseContextPanel,
  paneIdentity,
  PaneScope,
  DisplayedPanelLayoutProvider,
  PhonePanesProvider,
  InPaneDrawerProvider,
  presentsAsDrawer,
  coverPaneOf,
  RevealParticipant,
  useRevealReady,
} from "@/contexts"
import { Minimize2 } from "lucide-react"
import {
  Pane,
  PaneDropIndicator,
  PaneFocusContext,
  PanelTabTitle,
  paneDropZone,
  usePaneDrop,
  usePaneCovered,
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
  evenPanelColumns,
  evenShares,
  type PanelGridSizes,
} from "@/lib/panel-grid"
import { Drawer, DrawerContent, DrawerDescription, DrawerTitle } from "@/components/ui/drawer"
import {
  closePanelTab,
  firstColumnHolds,
  fitPanelLayout,
  fitPanelRows,
  floatingPanelTabs,
  panelSectionOf,
  panelIdsOf,
  isPanelOnShow,
  type PaneEdge,
  type PanelLayout,
  type PanelSection,
  type SplitDirection,
} from "@/lib/panel-tabs"
import { isPagePane } from "@/lib/stream-ids"
import { cn } from "@/lib/utils"
import { PanelResizeHandle } from "./panel-resize-handle"
import { PaneShortcuts } from "./pane-shortcuts"
import { useShellCover } from "./app-shell"
import { getDraftPromotionSource } from "@/lib/draft-promotions"
import { StreamPanel } from "@/components/thread"
import { ConversationPanel } from "@/components/conversations/conversation-panel"
import { ConversationsPane } from "@/components/conversations/conversations-pane"
import { ComposePanel } from "@/components/composer/compose-panel"
import { AsidePanel } from "@/components/aside/aside-panel"
import { StreamContextPane } from "@/components/stream-context"
import { PersonaTestChatPane } from "@/components/persona-editor/persona-test-chat"

/**
 * A draft thread promoted to its real stream keeps the draft's key, so its pane
 * survives the handoff; an overview keeps one key across its filters.
 */
function panelKeyFor(workspaceId: string, panelId: string): string {
  return getDraftPromotionSource(workspaceId, panelId) ?? paneIdentity(panelId)
}

/** A route's own `page:` pane: what it shows, and whether the first reveal can show it yet. */
export interface PageContent {
  node: ReactNode
  ready: boolean
}

export const PagePaneContext = createContext<PageContent | null>(null)

// Its own component, so a page's re-render reaches only the pane showing it.
function PagePane() {
  const page = useContext(PagePaneContext)
  useRevealReady(page?.ready ?? true)
  return page?.node ?? null
}

interface PanelHostProps {
  workspaceId: string
  onClose: () => void
  className?: string
}

/**
 * Picks the side panel's content by panel kind: a `conv:<id>` panel opens a
 * conversation projection (Mechanism B), a `compose:<id>` panel a stream's
 * draft, an `aside:<id>` panel the aside open on a stream, a `convs:<id>` panel
 * a stream's conversations list, a `context:<id>`
 * panel a stream's overview, a `test:<id>` panel a persona draft's test
 * chat, every other id is a stream/thread/draft handled
 * by {@link StreamPanel}, and a route's `page:` pane what its page provides
 * through {@link PagePaneContext}. Keyed on the panel id so
 * switching targets remounts cleanly — except a draft thread promoted to its real
 * stream, which keeps the draft's key so the panel carries its state across the
 * handoff instead of remounting. Hosts must not key this element themselves: an
 * outer `key={panelId}` unmounts the whole host on promotion, before the key
 * below can preserve anything.
 */
export function PanelHost({ workspaceId, onClose, className }: PanelHostProps) {
  const { panelId } = usePanel()
  // Every kind's content reports through `useRevealReady`; one that never does holds the first reveal to its cap.
  return (
    <RevealParticipant label={panelId ?? "empty pane"} covered={usePaneCovered()}>
      <PaneContent workspaceId={workspaceId} panelId={panelId} onClose={onClose} className={className} />
    </RevealParticipant>
  )
}

function PaneContent({ workspaceId, panelId, onClose, className }: PanelHostProps & { panelId: string | null }) {
  if (panelId && isPagePane(panelId)) return <PagePane />
  const composeStreamId = panelId && parseComposePanel(panelId)
  const context = panelId && parseContextPanel(panelId)
  const conversationsStreamId = panelId && parseConversationsPanel(panelId)
  const testedPersonaId = panelId && parsePersonaTestPanel(panelId)
  if (testedPersonaId) {
    return (
      <PersonaTestChatPane
        key={panelId}
        workspaceId={workspaceId}
        personaId={testedPersonaId}
        onClose={onClose}
        className={className}
      />
    )
  }
  if (panelId && isConversationPanel(panelId)) {
    return <ConversationPanel key={panelId} workspaceId={workspaceId} onClose={onClose} className={className} />
  }
  if (conversationsStreamId) {
    return (
      <ConversationsPane
        key={panelId}
        workspaceId={workspaceId}
        streamId={conversationsStreamId}
        onClose={onClose}
        className={className}
      />
    )
  }
  const asideHostId = panelId && parseAsidePanel(panelId)
  if (asideHostId) {
    return (
      <AsidePanel
        key={panelId}
        workspaceId={workspaceId}
        hostStreamId={asideHostId}
        onClose={onClose}
        className={className}
      />
    )
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
// A stream's header and composer with about 120px of timeline between them.
const MIN_STACKED_SECTION_HEIGHT = 320

/** How many sections fit down a column of the page's grid `height` pixels tall. */
export function panelMaxRows(height: number): number {
  return height > 0 ? Math.max(1, Math.floor(height / MIN_STACKED_SECTION_HEIGHT)) : Infinity
}

const NO_SPLITS: readonly SplitDirection[] = []
const NO_MAP: readonly PaneMapCell[] = []
const SPLIT_DOWN: readonly SplitDirection[] = ["down"]
const SPLIT_RIGHT: readonly SplitDirection[] = ["right"]
const SPLIT_ANY: readonly SplitDirection[] = ["right", "down"]
const EDGES_ANY: readonly PaneEdge[] = ["left", "right", "top", "bottom"]
const EDGES_ROW: readonly PaneEdge[] = ["top", "bottom"]
const EDGES_BESIDE: readonly PaneEdge[] = ["left", "right"]
const NO_EDGES: readonly PaneEdge[] = []

interface PanelTabStackProps {
  workspaceId: string
  /** How many of the arrangement's columns fit side by side; the rest fold into the last. */
  maxColumns: number
  /** How many sections fit down a column; the rest fold into the last. */
  maxRows: number
  /** Show every tab in one section (a phone). */
  stacked: boolean
  /** The page's arrangement, without the panes a sheet over it holds. */
  layout: PanelLayout
  /** The tabs on show, from {@link useFittedPanelLayout}, placed on the page's grid by {@link usePanelGrid}. */
  display: PanelLayout
  grid: PanelGridState
  /** Pixels the columns after the first share, or null where every tab fills the page (a phone). */
  width: number | null
  /** Pixels the first column fills, which a floating tab's map shows too. */
  firstColumnWidth: number
  /** Pixels of the page's grid's height, which the sections share. */
  height: number
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
  edges: readonly PaneEdge[]
}

type PanelGridState = ReturnType<typeof usePanelGrid>

/** The page's grid for `display`: its row tracks, each section's area, and the column shares as last dragged. */
export function usePanelGrid(display: PanelLayout) {
  const [sizes, setSizes] = usePanelGridSizes(display)
  const { rows, areas } = useMemo(() => compilePanelGrid(sizes), [sizes])
  return { sizes, setSizes, rows, areas }
}

/** `layout` as a window `maxColumns` wide and `maxRows` tall arranges it, or a phone when `stacked`. */
export function useFittedPanelLayout(
  layout: PanelLayout,
  maxColumns: number,
  stacked: boolean,
  maxRows = Infinity
): PanelLayout {
  const current = useCurrentPane()
  // Working in the first column leaves a folded section showing the pane last worked in outside it.
  const [lastPanel, setLastPanel] = useState(current)
  if (current !== null && current !== lastPanel && !firstColumnHolds(layout, current)) setLastPanel(current)
  return useMemo(() => {
    // A floating tab is always on show, even from a folded column.
    if (!stacked) {
      const shown = layout.focused?.[0] ?? current
      return fitPanelRows(fitPanelLayout(layout, maxColumns, false, shown, lastPanel), maxRows, shown, lastPanel)
    }
    // A phone shows a drawer over a page, so the page is on show behind it.
    const pages = panelIdsOf(layout).filter(presentsAsDrawer).reduce(closePanelTab, layout)
    const shown = current !== null && presentsAsDrawer(current) ? pageUnder(layout, current) : current
    return fitPanelLayout(pages, maxColumns, true, shown)
  }, [layout, maxColumns, maxRows, stacked, current, lastPanel])
}

/**
 * `layout` as the grid places it: a pane opened while focus is on floats with the
 * group and takes no cell until focus ends, so exiting only drops the scrim. A
 * group loaded from the URL was never laid out without its members, so each keeps its cell.
 */
export function useFocusGridLayout(layout: PanelLayout, stacked: boolean): PanelLayout {
  const [beforeFocus, setBeforeFocus] = useState(layout)
  if (layout.focused === undefined && beforeFocus !== layout) setBeforeFocus(layout)
  return useMemo(() => {
    if (stacked || layout.focused === undefined) return layout
    const before = panelIdsOf(beforeFocus)
    return layout.focused.filter((id) => !before.includes(id)).reduce(closePanelTab, layout)
  }, [layout, stacked, beforeFocus])
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
 * A pane that can't sit beside its stream (a phone) as a bottom
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
      <DrawerContent className="h-[88dvh] outline-none md:mx-auto md:max-w-2xl">
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
  maxRows,
  stacked,
  layout,
  display,
  grid,
  width,
  firstColumnWidth,
  height,
}: PanelTabStackProps) {
  const { setCurrentPane, focusTab, closeTab } = usePanel()
  const current = useCurrentPane()
  const { sizes, setSizes, areas } = grid
  const panelShares = sizes.columns.slice(1)
  const columnWidths = width === null ? null : panelColumnWidths(panelShares, width)

  // A folded section shows more than its own tabs, so a split from it would move a tab it doesn't hold.
  const folded = display !== layout
  const besideFits = layout.columns.length < maxColumns
  const splitsOf = (section: PanelSection, column: number) => {
    if (folded || section.ids.length < 2) return NO_SPLITS
    const belowFits = layout.columns[column].length < maxRows
    if (besideFits) return belowFits ? SPLIT_ANY : SPLIT_RIGHT
    return belowFits ? SPLIT_DOWN : NO_SPLITS
  }
  // Dropped beside a folded section, a tab would land in a column that doesn't show.
  const edgesOf = (column: number) => {
    if (folded) return NO_EDGES
    const belowFits = layout.columns[column].length < maxRows
    if (besideFits) return belowFits ? EDGES_ANY : EDGES_BESIDE
    return belowFits ? EDGES_ROW : NO_EDGES
  }
  const drops = usePaneDrop()
  const members = floatingPanelTabs(layout, stacked)
  const floating = members.length > 0
  // Members the grid doesn't show (no cell, or folded under another tab) float from outside it, so they keep their element across the exit.
  const unplaced: PlacedTab[] = members.flatMap((id) => {
    const section = isPanelOnShow(display, id) ? null : panelSectionOf(layout, id)
    if (!section) return []
    const key = panelKeyFor(workspaceId, id)
    return [{ key, id, area: "auto", width: null, inFirstColumn: false, section, splits: NO_SPLITS, edges: NO_EDGES }]
  })
  const tabs: PlacedTab[] = display.columns
    .flatMap((sections, column) =>
      sections.flatMap((section, row) => {
        const splits = splitsOf(section, column)
        const edges = edgesOf(column)
        return section.ids.map((id) => ({
          key: panelKeyFor(workspaceId, id),
          id,
          area: areas[column][row],
          width: column === 0 ? null : (columnWidths?.[column - 1] ?? null),
          inFirstColumn: firstColumnHolds(layout, id),
          section,
          splits,
          edges,
        }))
      })
    )
    .filter((tab) => !unplaced.some((member) => member.id === tab.id))
    .concat(unplaced)
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

  const firstShare = firstColumnWidth + (width ?? 0) > 0 ? firstColumnWidth / (firstColumnWidth + (width ?? 0)) : 1
  const restore = useCallback(() => focusTab(null), [focusTab])
  // Dismissing a floating draft sends it back inline rather than leaving it beside the stream.
  const draft = members.find((id) => parseComposePanel(id) !== null)
  const dismiss = useCallback(() => (draft ? closeTab(draft) : restore()), [draft, closeTab, restore])
  usePaneFocusEscape(floating, dismiss)
  useShellCover(floating)
  // Only Restore draws the map, so resizing with nothing floating leaves every pane's header alone.
  const map = useMemo(
    () => (floating ? paneMap(display, sizes, members, firstShare) : NO_MAP),
    [floating, display, sizes, members, firstShare]
  )
  const focus = useMemo(() => (stacked ? null : { focused: members, map }), [stacked, members, map])
  const unplacedKey = unplaced.map((tab) => tab.id).join(".")
  // Members floating from outside the grid are on screen too.
  const screen = useMemo(() => {
    if (unplacedKey === "") return display
    const ids = unplacedKey.split(".")
    const grid = ids.reduce(closePanelTab, display)
    return { columns: [...grid.columns, ...ids.map((id) => [{ ids: [id], active: id }])] }
  }, [display, unplacedKey])
  const ghosts = tabs.filter((tab) => tab.area !== "auto" && members.includes(tab.id))

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
        onReset={() => setSizes(evenPanelColumns(sizes))}
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
        onReset={() =>
          setSizes({ ...sizes, rows: sizes.rows.map((shares, at) => (at === column ? evenShares(shares) : shares)) })
        }
      />
    ))
  })

  return (
    <PhonePanesProvider value={phonePanes}>
      <PaneFocusContext.Provider value={focus}>
        <DisplayedPanelLayoutProvider value={screen}>
          {tabs.map((tab) => {
            const member = members.indexOf(tab.id)
            return (
              <Pane
                key={tab.key}
                // Out of its cell: fixed in the shell's translated box, the group floats as a row over the sidebar and every header.
                area={member === -1 ? tab.area : "auto"}
                covered={tab.id !== tab.section.active}
                // Focus mode is a class on the same pane, never a dialog: a portal would remount it and lose its draft and scroll.
                inert={floating && member === -1}
                className={cn(
                  "bg-background",
                  member !== -1 && "fixed inset-y-5 z-[47] rounded-[10px] border shadow-[0_24px_60px_rgba(0,0,0,0.28)]",
                  floating && member === -1 && "isolate"
                )}
                style={member === -1 ? undefined : floatingSlot(member, members.length)}
                data-testid={tab.inFirstColumn ? "main-pane" : "panel"}
                data-panel-tab={tab.id}
                data-front-panel={tab.id === current || undefined}
                data-focused-pane={member !== -1 || undefined}
                // A pressed pane becomes the route's once the click lands: the route's stream shows chrome the
                // others don't, which would shift a header button or fold a tab out from under the pointer.
                onClickCapture={() => setCurrentPane(tab.id)}
                onFocusCapture={(event) => {
                  if (event.target.matches(":focus-visible")) setCurrentPane(tab.id)
                }}
                {...paneDropZone(drops, tab.id, tab.edges)}
              >
                <div className="h-full" style={{ width: member === -1 ? (tab.width ?? undefined) : undefined }}>
                  <PaneScope panelId={tab.id} section={tab.section} splits={tab.splits}>
                    <ScopedPanelHost workspaceId={workspaceId} />
                  </PaneScope>
                </div>
              </Pane>
            )
          })}
        </DisplayedPanelLayoutProvider>
      </PaneFocusContext.Provider>
      {display.columns.map((sections, column) =>
        sections.map((section, row) => (
          <PaneDropIndicator key={`${column}:${row}`} of={section.active} area={areas[column][row]} />
        ))
      )}
      {ghosts.map((ghost) => (
        <div
          key={ghost.key}
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
      ))}
      {floating && (
        // Over the whole shell, above the sidebar (z-40) and the loading hairline (z-45).
        <div
          data-testid="pane-focus-scrim"
          className="fixed inset-0 z-[46] bg-[rgba(30,20,10,0.22)] dark:bg-black/55"
          onClick={dismiss}
        />
      )}
      {/* Under a floating tab they would still take Tab and the arrow keys. */}
      {!floating && columnResizers}
      {!floating && rowResizers}
      {shownSection?.active && (
        <PaneScope panelId={shownSection.active} section={shownSection} splits={NO_SPLITS}>
          <PaneShortcuts panes={panes} />
        </PaneScope>
      )}
    </PhonePanesProvider>
  )
}

const sum = (shares: readonly number[]) => shares.reduce((total, share) => total + share, 0)

/** The `index`th of `count` floating panes, sharing the width inside a 20px margin with 12px between them. */
function floatingSlot(index: number, count: number): CSSProperties {
  return {
    left: `calc(20px + (100% - 28px) * ${index} / ${count})`,
    width: `calc((100% - 28px) / ${count} - 12px)`,
  }
}

/** Each section on show: the first column at `firstShare` of the width, the rest by their shares of what is left. */
function paneMap(
  display: PanelLayout,
  sizes: PanelGridSizes,
  focused: readonly string[],
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
      focused: focused.includes(section.active),
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

/** The page grid's height, measured before paint so a short window never shows sections it folds. */
export function useHostHeight(host: RefObject<HTMLElement | null>) {
  const [height, setHeight] = useState(0)
  useLayoutEffect(() => {
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
  onReset: () => void
}

/** The divider between two sections, dragged or arrow-keyed like the panel's own edge. */
function SectionResizer({ axis, area, size, span, min, onResize, onReset }: SectionResizerProps) {
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
      onReset={onReset}
      ariaLabel={axis === "x" ? "Resize panels side by side" : "Resize stacked panels"}
    />
  )
}

const ScopedPanelHost = memo(function ScopedPanelHost({ workspaceId }: { workspaceId: string }) {
  const { closePanel } = usePanel()
  return <PanelHost workspaceId={workspaceId} onClose={closePanel} />
})
