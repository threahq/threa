import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type DragEvent } from "react"
import { Ban } from "lucide-react"
import { useCurrentPane, usePanel } from "@/contexts"
import {
  STREAM_DRAG_TYPE,
  readDroppedUrl,
  readStreamDrag,
  setMissedDropGuard,
  writeStreamDrag,
} from "@/lib/stream-drag"
import { isServerStreamId } from "@/lib/stream-ids"
import { isPinnedPagePane } from "@/lib/page-panes"
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

const carriesTab = (data: DataTransfer) => data.types.includes(PANE_DRAG_TYPE) || data.types.includes(STREAM_DRAG_TYPE)

/**
 * A tab, a sidebar row, or any link, which opens the pane it brings up. Only the types are readable until the
 * drop, so a link dragged in from another window lights a zone whatever it names.
 */
const carriesPane = (data: DataTransfer) => carriesTab(data) || data.types.includes("text/uri-list")

/** A dragged link allows only copy and link, so a move would refuse it. */
const dropEffectOf = (data: DataTransfer) => (carriesTab(data) ? "move" : "link")

function readPaneDrag(data: DataTransfer, workspaceId: string): string | null {
  try {
    const payload = JSON.parse(data.getData(PANE_DRAG_TYPE)) as { workspaceId?: string; panelId?: string }
    if (payload.workspaceId === workspaceId && payload.panelId) return payload.panelId
  } catch {
    // Not a tab: a sidebar row carries only the stream payload.
  }
  return readStreamDrag(data, workspaceId)
}

// The drag's payload is sealed until the drop, so the tab being dragged is kept beside it.
let dragged: string | null = null

/** The tab a drag of this page's own is carrying; null for a sidebar row or a link. */
export const draggedTab = () => dragged

/** Starts dragging the tab `panelId`, named `label`; a stream's tab carries its permalink too. */
export function startTabDrag(event: DragEvent<HTMLElement>, workspaceId: string, panelId: string, label: string) {
  dragged = panelId
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
  dragged = null
  setMissedDropGuard(false)
}

/** Props that make a pane's header title drag its tab, while there is another pane to drop it on. */
export function usePaneDragHandle(workspaceId: string, label: string, enabled = true) {
  const { panelId, shownPanes } = usePanel()
  const drops = usePaneDrop()
  const currentPane = useCurrentPane()
  // A page pane is pinned to the route's first column, so it has nowhere to go.
  if (!panelId || isPinnedPagePane(panelId) || shownPanes < 2 || !drops || !enabled) return {}
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

/** A link this page knows brings up no pane, which no pane takes. */
const REFUSED = "refused"

interface PaneDropTarget {
  drop: PaneDrop | typeof REFUSED
  /** A strip draws its own caret; a pane's zone is drawn over the pane. */
  via: "pane" | "strip"
  /** The pane, or the strip's section, by the tab it shows. */
  of: string
}

interface PaneDropState {
  target: PaneDropTarget | null
  hover: (target: PaneDropTarget | null) => void
  /** Whether the drag is of a link begun on this page that brings up no pane. */
  refuses: (data: DataTransfer) => boolean
  land: (data: DataTransfer, drop: PaneDrop) => void
}

/** Null where drops are off: a phone, a floating tab, a panel held by the aside. */
export const PaneDropContext = createContext<PaneDropState | null>(null)

const sameTarget = (a: PaneDropTarget | null, b: PaneDropTarget | null) => JSON.stringify(a) === JSON.stringify(b)

/** Where a drag over the stream page would land, for {@link PaneDropContext}; `onLand` hears of each pane dropped. */
export function usePaneDropState(
  workspaceId: string,
  onLand: (panelId: string, drop: PaneDrop) => void
): PaneDropState {
  const { dropTab, dropLink, linkPane } = usePanel()
  const [target, setTarget] = useState<PaneDropTarget | null>(null)
  // What a drag begun on this page carries: the pane its link brings up, null for a link that brings up none
  // and for anything else. A drag in from another window never starts here, so what it carries stays unread.
  const carried = useRef<{ from: Element; pane: string | null } | null>(null)
  useEffect(() => {
    const start = (event: globalThis.DragEvent) => {
      const from = event.target instanceof Element ? event.target : null
      const href = from?.closest<HTMLAnchorElement>("a[href]")?.href
      carried.current = from && { from, pane: href ? linkPane(href) : null }
    }
    const end = () => {
      carried.current = null
    }
    window.addEventListener("dragstart", start)
    window.addEventListener("dragend", end)
    return () => {
      window.removeEventListener("dragstart", start)
      window.removeEventListener("dragend", end)
    }
  }, [linkPane])
  const refuses = useCallback((data: DataTransfer) => {
    const drag = carried.current
    // A source unmounted mid-drag never fires its dragend, and would answer for the next drag in from outside.
    return !carriesTab(data) && drag !== null && drag.from.isConnected && drag.pane === null
  }, [])
  const hover = useCallback(
    (next: PaneDropTarget | null) => setTarget((current) => (sameTarget(current, next) ? current : next)),
    []
  )
  const land = useCallback(
    (data: DataTransfer, drop: PaneDrop) => {
      setTarget(null)
      const panelId = readPaneDrag(data, workspaceId)
      // A drop that unmounts the tab's own handle leaves no node for its dragend to reach.
      dragged = null
      const url = panelId ? null : readDroppedUrl(data)
      let landed: string | null = null
      if (panelId) landed = dropTab(panelId, drop)
      else if (url) landed = dropLink(url, drop)
      if (landed) onLand(landed, drop)
    },
    [workspaceId, dropTab, dropLink, onLand]
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

  return useMemo(() => ({ target, hover, refuses, land }), [target, hover, refuses, land])
}

export function usePaneDrop(): PaneDropState | null {
  return useContext(PaneDropContext)
}

/** A text field takes a dropped link as text, and the composer's card a dropped stream as a link, so a drag over one is its own. */
const overTextField = (event: DragEvent<HTMLElement>) =>
  event.target instanceof Element &&
  event.target.closest('[contenteditable="true"], input, textarea, [data-composer-card]') !== null

/**
 * Drop handlers for the pane showing `of`, whose `edges` split and whose
 * centre adds a tab. Undefined while drops are off.
 */
export function paneDropZone(drops: PaneDropState | null, of: string, edges: readonly PaneEdge[]) {
  // A route's page holds its column alone.
  if (!drops || isPinnedPagePane(of)) return undefined
  const { hover, refuses, land } = drops
  const dropAt = (event: DragEvent<HTMLElement>): PaneDrop | typeof REFUSED | null => {
    // A strip inside the pane has already claimed it.
    if (event.defaultPrevented || !carriesPane(event.dataTransfer) || overTextField(event)) return null
    if (refuses(event.dataTransfer)) return REFUSED
    // A tab whose handle lost its props mid-drag never fires its dragend; the next drag of anything else clears it.
    if (!event.dataTransfer.types.includes(PANE_DRAG_TYPE)) dragged = null
    const zone = paneDropZoneAt(event.currentTarget.getBoundingClientRect(), event.clientX, event.clientY, edges)
    if (zone !== "centre") return { kind: "edge", of, side: zone }
    return { kind: "tab", of, before: null }
  }
  return {
    onDragOver: (event: DragEvent<HTMLElement>) => {
      // The composer's card claims its drags first, so the zone its drag crossed on the way in is cleared here.
      if (event.defaultPrevented && !overTextField(event)) return
      const drop = dropAt(event)
      hover(drop && { drop, via: "pane", of })
      if (!drop) return
      // Without preventDefault the browser refuses the drop outright.
      event.preventDefault()
      event.dataTransfer.dropEffect = drop === REFUSED ? "none" : dropEffectOf(event.dataTransfer)
    },
    onDragLeave: (event: DragEvent<HTMLElement>) => {
      // Crossing between children re-fires leave; only the pane's own boundary ends the hover.
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) hover(null)
    },
    onDrop: (event: DragEvent<HTMLElement>) => {
      const drop = dropAt(event)
      if (!drop || drop === REFUSED) return
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
  const { hover, refuses, land } = drops
  const dropAt = (event: DragEvent<HTMLElement>): PaneDrop | null => {
    // A refused link is the pane's to refuse, over the whole of it.
    if (!carriesPane(event.dataTransfer) || refuses(event.dataTransfer)) return null
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
      event.dataTransfer.dropEffect = dropEffectOf(event.dataTransfer)
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
  if (target?.via !== "strip" || target.of !== of || target.drop === REFUSED || target.drop.kind !== "tab") return null
  return { before: target.drop.before }
}

// An edge drop marks its edge, so one previewing a width that fills the pane still reads as a split, not a tab.
const EDGE_SHAPES: Record<PaneEdge, string> = {
  left: "inset-y-0 left-0 border-l-2 border-primary",
  right: "inset-y-0 right-0 border-r-2 border-primary",
  top: "inset-x-0 top-0 h-1/2 border-t-2 border-primary",
  bottom: "inset-x-0 bottom-0 h-1/2 border-b-2 border-primary",
}

interface PaneDropIndicatorProps {
  of: string
  area: string
  /** What a pane dropped on a side edge opens at: its own width, where it brings one; else half of the pane's. */
  width: number | null
}

/** Where a drop over the pane showing `of` would land, drawn over the grid `area` it fills. */
export function PaneDropIndicator({ of, area, width }: PaneDropIndicatorProps) {
  const target = usePaneDrop()?.target
  if (target?.via !== "pane" || target.of !== of) return null
  const { drop } = target
  const beside = drop !== REFUSED && drop.kind === "edge" && (drop.side === "left" || drop.side === "right")
  return (
    <div aria-hidden className="pointer-events-none relative z-20 min-h-0 min-w-0" style={{ gridArea: area }}>
      {drop === REFUSED ? (
        <div
          data-testid="pane-drop-indicator"
          data-drop={REFUSED}
          className="absolute inset-0 flex items-center justify-center bg-background/70 text-muted-foreground"
        >
          <Ban className="size-8" />
        </div>
      ) : (
        <div
          data-testid="pane-drop-indicator"
          data-drop={drop.kind === "edge" ? drop.side : "centre"}
          className={cn(
            "absolute rounded-md bg-primary/10 ring-2 ring-primary/40 ring-inset",
            drop.kind === "edge" ? EDGE_SHAPES[drop.side] : "inset-0",
            beside && (width === null ? "w-1/2" : "max-w-full")
          )}
          style={beside && width !== null ? { width } : undefined}
        />
      )}
    </div>
  )
}
