import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react"
import { usePanel, useFrontPanel, isConversationPanel, PaneScope } from "@/contexts"
import { Pane } from "@/components/panes"
import { useResizeDrag } from "@/hooks/use-resize-drag"
import { compilePanelGrid, defaultPanelGridSizes, panelGridShape, resplit, type PanelGridSizes } from "@/lib/panel-grid"
import { fitPanelLayout, type PanelLayout, type PanelSection, type SplitDirection } from "@/lib/panel-tabs"
import { cn } from "@/lib/utils"
import { PanelResizeHandle } from "./panel-resize-handle"
import { getDraftPromotionSource } from "@/lib/draft-promotions"
import { StreamPanel } from "@/components/thread"
import { ConversationPanel } from "@/components/conversations/conversation-panel"

/** A draft thread promoted to its real stream keeps the draft's key, so its pane survives the handoff. */
function panelKeyFor(workspaceId: string, panelId: string): string {
  return getDraftPromotionSource(workspaceId, panelId) ?? panelId
}

interface PanelHostProps {
  workspaceId: string
  onClose: () => void
  className?: string
}

/**
 * Picks the side panel's content by panel kind: a `conv:<id>` panel opens a
 * conversation projection (Mechanism B), every other id is a stream/thread/draft
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
  if (panelId && isConversationPanel(panelId)) {
    return <ConversationPanel key={panelId} workspaceId={workspaceId} onClose={onClose} className={className} />
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
const SPLIT_DOWN: readonly SplitDirection[] = ["down"]
const SPLIT_ANY: readonly SplitDirection[] = ["right", "down"]

interface PanelTabStackProps {
  workspaceId: string
  /** How many of the arrangement's columns fit side by side; the rest fold into the last. */
  maxColumns: number
  /** Show every tab in one section (a phone). */
  stacked: boolean
}

interface PlacedTab {
  key: string
  id: string
  area: string
  section: PanelSection
  splits: readonly SplitDirection[]
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
export function PanelTabStack({ workspaceId, maxColumns, stacked }: PanelTabStackProps) {
  const { layout, setCurrentPane } = usePanel()
  const front = useFrontPanel()
  const display = useMemo(
    () => fitPanelLayout(layout, maxColumns, stacked, front),
    [layout, maxColumns, stacked, front]
  )
  const [sizes, setSizes] = usePanelGridSizes(display)
  const grid = compilePanelGrid(sizes)
  const ref = useRef<HTMLDivElement>(null)
  const box = useBoxSize(ref)

  // A folded section shows more than its own tabs, so a split from it would move a tab it doesn't hold.
  const folded = display !== layout
  const splitsOf = (section: PanelSection) => {
    if (folded || section.ids.length < 2) return NO_SPLITS
    return layout.columns.length < maxColumns ? SPLIT_ANY : SPLIT_DOWN
  }
  const tabs: PlacedTab[] = display.columns
    .flatMap((sections, column) =>
      sections.flatMap((section, row) => {
        const splits = splitsOf(section)
        return section.ids.map((id) => ({
          key: panelKeyFor(workspaceId, id),
          id,
          area: grid.areas[column][row],
          section,
          splits,
        }))
      })
    )
    .sort((a, b) => (a.key < b.key ? -1 : 1))

  const columnUnit = box.width / sum(sizes.columns)
  const columnResizers = sizes.columns
    .slice(1)
    .map((share, index) => (
      <SectionResizer
        key={`column:${index}`}
        axis="x"
        area={`1 / ${index + 2} / -1 / ${index + 3}`}
        size={sizes.columns[index] * columnUnit}
        span={(sizes.columns[index] + share) * columnUnit}
        min={MIN_SECTION_WIDTH}
        onResize={(px) => setSizes({ ...sizes, columns: resplit(sizes.columns, index, px / columnUnit) })}
      />
    ))
  const rowResizers = sizes.rows.flatMap((rows, column) => {
    const unit = box.height / sum(rows)
    return rows.slice(1).map((share, index) => (
      <SectionResizer
        key={`row:${column}:${index}`}
        axis="y"
        area={grid.areas[column][index + 1]}
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
    <div ref={ref} className="grid h-full" style={{ gridTemplateColumns: grid.columns, gridTemplateRows: grid.rows }}>
      {tabs.map((tab) => (
        <Pane
          key={tab.key}
          area={tab.area}
          covered={tab.id !== tab.section.active}
          data-panel-tab={tab.id}
          data-front-panel={tab.id === front || undefined}
          onPointerDownCapture={() => setCurrentPane(tab.id)}
          onFocusCapture={() => setCurrentPane(tab.id)}
        >
          <PaneScope panelId={tab.id} section={tab.section} splits={tab.splits}>
            <ScopedPanelHost workspaceId={workspaceId} />
          </PaneScope>
        </Pane>
      ))}
      {columnResizers}
      {rowResizers}
    </div>
  )
}

const sum = (shares: readonly number[]) => shares.reduce((total, share) => total + share, 0)

/** Section sizes last dragged for this arrangement's shape, so undoing a split finds the old sizes again. */
function usePanelGridSizes(display: PanelLayout) {
  const [stored, setStored] = useState<Record<string, PanelGridSizes>>({})
  const shape = panelGridShape(display)
  const setSizes = useCallback(
    (next: PanelGridSizes) => setStored((current) => ({ ...current, [shape]: next })),
    [shape]
  )
  return [stored[shape] ?? defaultPanelGridSizes(display), setSizes] as const
}

/** Width and height together: `useElementWidth`'s callers must not re-render as their height changes. */
function useBoxSize(ref: RefObject<HTMLElement | null>) {
  const [box, setBox] = useState({ width: 0, height: 0 })
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const measure = () => setBox({ width: element.clientWidth, height: element.clientHeight })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])
  return box
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
