import { createContext, useCallback, useContext, useEffect, useMemo, useState, type DragEvent } from "react"
import { useCurrentPane, usePanel } from "@/contexts"
import { STREAM_DRAG_TYPE, readStreamDrag, setMissedDropGuard, writeStreamDrag } from "@/lib/stream-drag"
import { isPagePane, isServerStreamId } from "@/lib/stream-ids"
import type { PaneDrop, PaneEdge } from "@/lib/panel-tabs"
import { cn } from "@/lib/utils"

/**
 * Tabs and sidebar rows dropped on the stream page's panes: a pane's edge
 * splits beside it, its centre adds a tab, a tab strip splices between its
 * tabs. Native HTML5 drag, as the sidebar's rows already are (lib/stream-drag.ts), so a stream tab dropped
 * in the composer or another window is its permalink, and one dropped on a
 * sidebar section files it there. Desktop only, like the rows.
 */

/** A dragged tab: any pane id, where {@link STREAM_DRAG_TYPE} carries only streams. */
const PANE_DRAG_TYPE = "application/x-threa-pane+json"

/** How deep an edge's band reaches into a pane, as a share of its size. */
const EDGE_BAND = 0.25

const carriesPane = (data: DataTransfer) => data.types.includes(PANE_DRAG_TYPE) || data.types.includes(STREAM_DRAG_TYPE)

function readPaneDrag(data: DataTransfer, workspaceId: string): string | null {
  try {
    const payload = JSON.parse(data.getData(PANE_DRAG_TYPE)) as { workspaceId?: string; panelId?: string }
    if (payload.workspaceId === workspaceId && payload.panelId) return payload.panelId
  } catch {
    // Not a tab: a sidebar row carries only the stream payload.
  }
  return readStreamDrag(data, workspaceId)
}

/** Starts dragging the tab `panelId`, named `label`; a stream's tab carries its permalink too. */
export function startTabDrag(event: DragEvent<HTMLElement>, workspaceId: string, panelId: string, label: string) {
  const data = event.dataTransfer
  // The link's own flavours name the page URL with this tab brought forward, which means nothing elsewhere.
  data.clearData()
  if (isServerStreamId(panelId)) {
    writeStreamDrag(data, workspaceId, panelId, label)
  }
  data.setData(PANE_DRAG_TYPE, JSON.stringify({ workspaceId, panelId }))
  data.effectAllowed = "all"
  setMissedDropGuard(true)
}

export function endTabDrag() {
  setMissedDropGuard(false)
}

/** Props that make a pane's header title drag its tab, while there is another pane to drop it on. */
export function usePaneDragHandle(workspaceId: string, label: string, enabled = true) {
  const { panelId, shownPanes } = usePanel()
  const drops = usePaneDrop()
  const currentPane = useCurrentPane()
  // A page pane is pinned to the route's first column, so it has nowhere to go.
  if (!panelId || isPagePane(panelId) || shownPanes < 2 || !drops || !enabled) return {}
  return {
    draggable: true,
    onDragStart: (event: DragEvent<HTMLElement>) => {
      // A breadcrumb or other link inside the title drags as itself.
      if (
        event.target instanceof Element &&
        event.target.closest('a[href], [draggable="true"]') !== event.currentTarget
      )
        return
      startTabDrag(event, workspaceId, panelId, label)
    },
    onDragEnd: endTabDrag,
    "data-pane-drag-handle": "",
    "data-pane-idle": currentPane === panelId ? undefined : "",
  }
}

/** The edge band of `box` under the pointer, among `edges`, else the centre. */
export function paneDropZoneAt(
  box: { left: number; top: number; width: number; height: number },
  x: number,
  y: number,
  edges: readonly PaneEdge[]
): PaneEdge | "centre" {
  const reach: Record<PaneEdge, number> = {
    left: (x - box.left) / box.width,
    right: (box.left + box.width - x) / box.width,
    top: (y - box.top) / box.height,
    bottom: (box.top + box.height - y) / box.height,
  }
  const nearest = edges.filter((edge) => reach[edge] < EDGE_BAND).sort((a, b) => reach[a] - reach[b])[0]
  return nearest ?? "centre"
}

interface PaneDropTarget {
  drop: PaneDrop
  /** A strip draws its own caret; a pane's zone is drawn over the pane. */
  via: "pane" | "strip"
  /** The pane, or the strip's section, by the tab it shows. */
  of: string
}

interface PaneDropState {
  target: PaneDropTarget | null
  hover: (target: PaneDropTarget | null) => void
  land: (data: DataTransfer, drop: PaneDrop) => void
}

/** Null where drops are off: a phone, a floating tab, a panel held by the aside. */
export const PaneDropContext = createContext<PaneDropState | null>(null)

const sameTarget = (a: PaneDropTarget | null, b: PaneDropTarget | null) => JSON.stringify(a) === JSON.stringify(b)

/** Where a drag over the stream page would land, for {@link PaneDropContext}. */
export function usePaneDropState(workspaceId: string): PaneDropState {
  const { dropTab } = usePanel()
  const [target, setTarget] = useState<PaneDropTarget | null>(null)
  const hover = useCallback(
    (next: PaneDropTarget | null) => setTarget((current) => (sameTarget(current, next) ? current : next)),
    []
  )
  const land = useCallback(
    (data: DataTransfer, drop: PaneDrop) => {
      setTarget(null)
      const panelId = readPaneDrag(data, workspaceId)
      if (panelId) dropTab(panelId, drop)
    },
    [workspaceId, dropTab]
  )

  // A drag cancelled, or dropped where no zone claimed it, never leaves the zone it last crossed.
  useEffect(() => {
    if (target === null) return
    const clear = () => setTarget(null)
    window.addEventListener("dragend", clear)
    window.addEventListener("drop", clear)
    return () => {
      window.removeEventListener("dragend", clear)
      window.removeEventListener("drop", clear)
    }
  }, [target])

  return useMemo(() => ({ target, hover, land }), [target, hover, land])
}

export function usePaneDrop(): PaneDropState | null {
  return useContext(PaneDropContext)
}

/** The composer takes a dropped stream as a link, so a drag over an editor is the editor's. */
const overEditor = (event: DragEvent<HTMLElement>) =>
  event.target instanceof Element && event.target.closest('[contenteditable="true"]') !== null

/**
 * Drop handlers for the pane showing `of`, whose `edges` split and whose
 * centre adds a tab. Undefined while drops are off.
 */
export function paneDropZone(drops: PaneDropState | null, of: string, edges: readonly PaneEdge[]) {
  // A route's page holds its column alone.
  if (!drops || isPagePane(of)) return undefined
  const { hover, land } = drops
  const dropAt = (event: DragEvent<HTMLElement>): PaneDrop | null => {
    // A strip inside the pane has already claimed it.
    if (event.defaultPrevented || !carriesPane(event.dataTransfer) || overEditor(event)) return null
    const zone = paneDropZoneAt(event.currentTarget.getBoundingClientRect(), event.clientX, event.clientY, edges)
    if (zone !== "centre") return { kind: "edge", of, side: zone }
    return { kind: "tab", of, before: null }
  }
  return {
    onDragOver: (event: DragEvent<HTMLElement>) => {
      if (event.defaultPrevented) return
      const drop = dropAt(event)
      hover(drop && { drop, via: "pane", of })
      if (!drop) return
      // Without preventDefault the browser refuses the drop outright.
      event.preventDefault()
      event.dataTransfer.dropEffect = "move"
    },
    onDragLeave: (event: DragEvent<HTMLElement>) => {
      // Crossing between children re-fires leave; only the pane's own boundary ends the hover.
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) hover(null)
    },
    onDrop: (event: DragEvent<HTMLElement>) => {
      const drop = dropAt(event)
      if (!drop) return
      event.preventDefault()
      land(event.dataTransfer, drop)
    },
  }
}

/**
 * Drop handlers for the tab strip of the section showing `of`, splicing before
 * the shown tab whose middle the pointer is left of, else after the last shown
 * tab. Tabs carry `data-tab-id`.
 */
export function useStripDropZone(of: string | null) {
  const drops = usePaneDrop()
  if (!drops || of === null) return undefined
  const { hover, land } = drops
  const dropAt = (event: DragEvent<HTMLElement>): PaneDrop | null => {
    if (!carriesPane(event.dataTransfer)) return null
    const tabs = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-tab-id]")].map((tab) => ({
      id: tab.dataset.tabId!,
      box: tab.getBoundingClientRect(),
    }))
    const next = tabs.find(({ box }) => event.clientX < box.left + box.width / 2)
    // Appends after the last shown tab, where the caret is: anchored on `of`, the tab on show would drop onto itself.
    return next ? { kind: "tab", of, before: next.id } : { kind: "tab", of: tabs.at(-1)?.id ?? of, before: null }
  }
  // The pane under the strip reads `defaultPrevented` as the strip's claim, not as its own top edge.
  return {
    onDragOver: (event: DragEvent<HTMLElement>) => {
      const drop = dropAt(event)
      if (!drop) return
      event.preventDefault()
      event.dataTransfer.dropEffect = "move"
      hover({ drop, via: "strip", of })
    },
    onDragLeave: (event: DragEvent<HTMLElement>) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) hover(null)
    },
    onDrop: (event: DragEvent<HTMLElement>) => {
      const drop = dropAt(event)
      if (!drop) return
      event.preventDefault()
      land(event.dataTransfer, drop)
    },
  }
}

/** Where a drop on the strip of the section showing `of` would splice, if one is over it. */
export function useStripCaret(of: string | null): { before: string | null } | null {
  const target = usePaneDrop()?.target
  if (target?.via !== "strip" || target.of !== of || target.drop.kind !== "tab") return null
  return { before: target.drop.before }
}

const EDGE_SHAPES: Record<PaneEdge, string> = {
  left: "inset-y-0 left-0 w-1/2",
  right: "inset-y-0 right-0 w-1/2",
  top: "inset-x-0 top-0 h-1/2",
  bottom: "inset-x-0 bottom-0 h-1/2",
}

/** Where a drop over the pane showing `of` would land, drawn over the grid `area` it fills. */
export function PaneDropIndicator({ of, area }: { of: string; area: string }) {
  const target = usePaneDrop()?.target
  if (target?.via !== "pane" || target.of !== of) return null
  const { drop } = target
  return (
    <div aria-hidden className="pointer-events-none relative z-20 min-h-0 min-w-0" style={{ gridArea: area }}>
      <div
        data-testid="pane-drop-indicator"
        data-drop={drop.kind === "edge" ? drop.side : "centre"}
        className={cn(
          "absolute rounded-md bg-primary/10 ring-2 ring-primary/40 ring-inset",
          drop.kind === "edge" ? EDGE_SHAPES[drop.side] : "inset-0"
        )}
      />
    </div>
  )
}
