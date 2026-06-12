import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react"
import { cn } from "@/lib/utils"
import { usePanel, useSidebar } from "@/contexts"
import { PanelInstanceProvider, useFocusedPane } from "@/contexts/panel-instance-context"
import { useKeyboardShortcuts } from "@/hooks"
import { useResizeDrag } from "@/hooks/use-resize-drag"
import { PanelContentRenderer } from "@/components/panels/panel-renderer"
import { panelIdToMainPath } from "@/lib/panel-locations"
import { PanelResizeHandle } from "./panel-resize-handle"

const DEFAULT_PANEL_WIDTH = 480
const MIN_PANEL_WIDTH = 300
const MAX_PANEL_RATIO = 0.6
/** Pointer must travel this far before a header-press becomes a drag. */
const DRAG_THRESHOLD_PX = 6
/** Right edge of the main view that acts as a "dock panel here" zone. */
const MAIN_EDGE_ZONE_PX = 120
/** Open/close slide duration; the exit fallback must outlive the transition. */
const SLIDE_MS = 200

interface OverlayRect {
  left: number
  top: number
  width: number
  height: number
}

/** All drop targets are positions in the combined pane order — pane 0 included. */
interface DropTarget {
  index: number
  rect: OverlayRect
}

interface DragState {
  panelId: string
  title: string
  /** Pointer position relative to the area container. */
  x: number
  y: number
  target: DropTarget | null
}

/**
 * A rendered slot in the strip. `key` is the slot's identity and survives
 * in-place content replacement (draft promotion swaps `draft:…` for the real
 * thread id without closing the slot); `closing` marks a slot playing its
 * exit slide before unmounting.
 */
interface SlotItem {
  id: string
  key: string
  closing: boolean
}

/**
 * Compute the next slot list for a new panel id list. Slot keys are stable:
 * - ids that remain keep their slot (and its width/animation state)
 * - a single same-position id swap transfers the slot key (in-place content
 *   replacement — the panel must not close and reopen)
 * - removed ids stay as `closing` slots until their exit slide finishes
 */
export function reconcileSlots(prev: SlotItem[], panels: string[], nextKey: () => string): SlotItem[] {
  const openItems = prev.filter((it) => !it.closing)
  const openIds = openItems.map((it) => it.id)
  if (
    openIds.length === panels.length &&
    openIds.every((id, i) => id === panels[i]) &&
    openItems.length === prev.length
  ) {
    return prev
  }

  const panelSet = new Set(panels)
  const removed = openItems.filter((it) => !panelSet.has(it.id))
  const added = panels.filter((id) => !openIds.includes(id))
  const replacedInPlace =
    removed.length === 1 && added.length === 1 && openIds.indexOf(removed[0].id) === panels.indexOf(added[0])

  const keyById = new Map(openItems.map((it) => [it.id, it.key]))
  if (replacedInPlace) keyById.set(added[0], removed[0].key)

  const next: SlotItem[] = panels.map((id) => ({ id, key: keyById.get(id) ?? nextKey(), closing: false }))

  // Re-insert exiting slots near their previous position so the close slide
  // plays where the panel was. A reopened id cancels its pending exit.
  prev.forEach((it, idx) => {
    if (panelSet.has(it.id)) return
    if (replacedInPlace && it.key === removed[0].key) return
    next.splice(Math.min(idx, next.length), 0, { id: it.id, key: it.key, closing: true })
  })

  return next
}

interface WorkspacePanelAreaProps {
  workspaceId: string
  children: ReactNode
}

/**
 * The desktop pane layout: the routed main view plus an ordered strip of side
 * panels, all driven by the `?panel=` URL params. Owns per-panel widths,
 * pane focus, keyboard pane navigation, and drag-reordering of panels (drag a
 * panel header; drop zones preview as a highlight; Escape cancels).
 *
 * On mobile there is no strip — the most recent panel takes over the page,
 * matching the previous full-screen thread behavior.
 */
export function WorkspacePanelArea({ workspaceId, children }: WorkspacePanelAreaProps) {
  const { panels, panes, paneZeroId, closePanel, closePane, movePane, setFocusedPane, getFocusedPane } = usePanel()
  const { isMobile } = useSidebar()

  const containerRef = useRef<HTMLDivElement>(null)
  const mainRef = useRef<HTMLDivElement>(null)
  const slotElsRef = useRef(new Map<string, HTMLDivElement>())

  // Slots that mount after the area itself animate open; slots present on
  // first paint (deep links) appear instantly.
  const areaMountedRef = useRef(false)
  useEffect(() => {
    areaMountedRef.current = true
  }, [])

  // ---- Slot lifecycle (stable identity + exit animation) -------------------

  const slotKeyCounterRef = useRef(0)
  const nextSlotKey = useCallback(() => `slot-${slotKeyCounterRef.current++}`, [])
  const [slots, setSlots] = useState<SlotItem[]>(() => panels.map((id) => ({ id, key: nextSlotKey(), closing: false })))

  // Layout effect so a removed panel becomes a `closing` slot in the same
  // paint — a passive effect would flash it gone before the exit slide.
  useLayoutEffect(() => {
    setSlots((prev) => reconcileSlots(prev, panels, nextSlotKey))
  }, [panels, nextSlotKey])

  const handleSlotExited = useCallback((slotKey: string) => {
    setSlots((prev) => prev.filter((it) => it.key !== slotKey || !it.closing))
    setSlotWidths((prev) => {
      if (!(slotKey in prev)) return prev
      const next = { ...prev }
      delete next[slotKey]
      return next
    })
  }, [])

  const registerSlotEl = useCallback((panelId: string, el: HTMLDivElement | null) => {
    if (el) slotElsRef.current.set(panelId, el)
    else slotElsRef.current.delete(panelId)
  }, [])

  // ---- Pane widths ---------------------------------------------------------

  // Widths are keyed by slot identity (not pane id) so they survive in-place
  // content replacement, and live up here so equalize can set several at once.
  const [slotWidths, setSlotWidths] = useState<Record<string, number>>({})
  const slotsRef = useRef(slots)
  slotsRef.current = slots

  const setSlotWidth = useCallback((slotKey: string, width: number) => {
    setSlotWidths((prev) => ({ ...prev, [slotKey]: width }))
  }, [])

  /** Distribute the container evenly across all panes (pane 0 included). */
  const equalizeAllPanes = useCallback(() => {
    const container = containerRef.current
    if (!container) return
    const openSlots = slotsRef.current.filter((it) => !it.closing)
    if (openSlots.length === 0) return
    const per = Math.max(MIN_PANEL_WIDTH, Math.floor(container.offsetWidth / (openSlots.length + 1)))
    setSlotWidths((prev) => {
      const next = { ...prev }
      for (const it of openSlots) next[it.key] = per
      return next
    })
  }, [])

  /**
   * Equalize the two panes a divider borders on: the slot owning the handle
   * and its left neighbor (another slot, or pane 0 — which sizes itself, so
   * halving the slot's share is enough there).
   */
  const equalizePairAt = useCallback((slotKey: string) => {
    const openSlots = slotsRef.current.filter((it) => !it.closing)
    const idx = openSlots.findIndex((it) => it.key === slotKey)
    if (idx === -1) return
    const ownEl = slotElsRef.current.get(openSlots[idx].id)
    const ownWidth = ownEl?.getBoundingClientRect().width ?? DEFAULT_PANEL_WIDTH
    const leftEl = idx === 0 ? mainRef.current : slotElsRef.current.get(openSlots[idx - 1].id)
    const leftWidth = leftEl?.getBoundingClientRect().width ?? DEFAULT_PANEL_WIDTH
    const per = Math.max(MIN_PANEL_WIDTH, Math.round((ownWidth + leftWidth) / 2))
    setSlotWidths((prev) => {
      const next = { ...prev, [slotKey]: per }
      if (idx > 0) next[openSlots[idx - 1].key] = per
      return next
    })
  }, [])

  // The quick switcher's "Equalize panes" command reaches the area via a DOM
  // event — same pattern as "threa:open-stream-search".
  useEffect(() => {
    const handler = () => equalizeAllPanes()
    document.addEventListener("threa:equalize-panes", handler)
    return () => document.removeEventListener("threa:equalize-panes", handler)
  }, [equalizeAllPanes])

  // ---- Drag to reorder ----------------------------------------------------

  const [drag, setDrag] = useState<DragState | null>(null)
  const dragRef = useRef<DragState | null>(null)
  dragRef.current = drag
  const panesRef = useRef(panes)
  panesRef.current = panes
  const paneZeroRef = useRef(paneZeroId)
  paneZeroRef.current = paneZeroId

  const endDrag = useCallback(() => {
    setDrag(null)
    document.body.style.userSelect = ""
    document.body.style.cursor = ""
  }, [])

  const commitDrag = useCallback(
    (state: DragState) => {
      const target = state.target
      if (!target) return
      const from = panesRef.current.indexOf(state.panelId)
      if (from === -1) return
      movePane(state.panelId, from < target.index ? target.index - 1 : target.index)
    },
    [movePane]
  )

  const computeTarget = useCallback(
    (clientX: number, clientY: number, draggedId: string): DropTarget | null => {
      const container = containerRef.current
      const main = mainRef.current
      if (!container || !main) return null
      const containerRect = container.getBoundingClientRect()
      if (
        clientX < containerRect.left ||
        clientX > containerRect.right ||
        clientY < containerRect.top ||
        clientY > containerRect.bottom
      ) {
        return null
      }
      const rel = (left: number, top: number, width: number, height: number): OverlayRect => ({
        left: left - containerRect.left,
        top: top - containerRect.top,
        width,
        height,
      })

      // All panes are positions in one combined order. Each pane contributes
      // two half-zones: left half inserts before it, right half after it.
      const currentPanes = panesRef.current
      const paneZero = paneZeroRef.current
      const draggedIndex = currentPanes.indexOf(draggedId)
      const draggedIsRoutable = panelIdToMainPath(workspaceId, draggedId) != null

      const zoneFor = (r: DOMRect, paneIndex: number): DropTarget | null => {
        const before = clientX < r.left + r.width / 2
        const index = before ? paneIndex : paneIndex + 1
        // Dropping back onto its own position is a no-op — no zone to show.
        if (index === draggedIndex || index === draggedIndex + 1) return null
        // Index 0 is the routed page; a pane with no route can't take it.
        if (index === 0 && paneZero && !draggedIsRoutable) return null
        return {
          index,
          rect: before
            ? rel(r.left, r.top, r.width / 2, r.height)
            : rel(r.left + r.width / 2, r.top, r.width / 2, r.height),
        }
      }

      const sideBase = paneZero ? 1 : 0
      const sidePanes = currentPanes.slice(sideBase)
      for (let i = 0; i < sidePanes.length; i++) {
        const el = slotElsRef.current.get(sidePanes[i])
        if (!el) continue
        const r = el.getBoundingClientRect()
        if (clientX < r.left || clientX > r.right) continue
        return zoneFor(r, sideBase + i)
      }

      const mainRect = main.getBoundingClientRect()
      if (clientX >= mainRect.left && clientX <= mainRect.right) {
        if (paneZero) return zoneFor(mainRect, 0)
        // The routed page has no pane equivalent — only the right edge acts
        // as an "insert first panel here" zone.
        if (clientX > mainRect.right - MAIN_EDGE_ZONE_PX && draggedIndex !== 0) {
          const stripWidth = Math.min(360, mainRect.width * 0.35)
          return { index: 0, rect: rel(mainRect.right - stripWidth, mainRect.top, stripWidth, mainRect.height) }
        }
      }
      return null
    },
    [workspaceId]
  )

  const getDragHandleProps = useCallback(
    (panelId: string) => ({
      onPointerDown: (e: React.PointerEvent) => {
        if (e.button !== 0) return
        // Buttons/links/menus in the header keep their own interactions.
        const target = e.target as HTMLElement
        if (target.closest("button, a, input, textarea, select, [contenteditable], [role='menuitem']")) return

        const startX = e.clientX
        const startY = e.clientY
        let started = false

        const handleMove = (ev: PointerEvent) => {
          if (!started) {
            if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_THRESHOLD_PX) return
            started = true
            const paneEl = slotElsRef.current.get(panelId) ?? (panelId === paneZeroRef.current ? mainRef.current : null)
            const headerEl = paneEl?.querySelector("header")
            // The title element, not the whole header — header textContent
            // would also pick up button labels ("Close", "Panel actions").
            const headerText = headerEl?.querySelector("h1, h2, h3")?.textContent?.trim()
            document.body.style.userSelect = "none"
            document.body.style.cursor = "grabbing"
            const containerRect = containerRef.current?.getBoundingClientRect()
            setDrag({
              panelId,
              title: headerText || "Panel",
              x: ev.clientX - (containerRect?.left ?? 0),
              y: ev.clientY - (containerRect?.top ?? 0),
              target: computeTarget(ev.clientX, ev.clientY, panelId),
            })
            return
          }
          ev.preventDefault()
          const containerRect = containerRef.current?.getBoundingClientRect()
          setDrag((prev) =>
            prev
              ? {
                  ...prev,
                  x: ev.clientX - (containerRect?.left ?? 0),
                  y: ev.clientY - (containerRect?.top ?? 0),
                  target: computeTarget(ev.clientX, ev.clientY, panelId),
                }
              : prev
          )
        }

        const cleanup = () => {
          window.removeEventListener("pointermove", handleMove)
          window.removeEventListener("pointerup", handleUp)
          window.removeEventListener("keydown", handleKey, { capture: true })
          endDrag()
        }

        const handleUp = () => {
          const state = dragRef.current
          if (started && state) commitDrag(state)
          cleanup()
        }

        // Escape cancels the drag and restores the previous order (capture
        // phase so dialogs/popovers underneath don't also react).
        const handleKey = (ev: KeyboardEvent) => {
          if (ev.key !== "Escape") return
          ev.preventDefault()
          ev.stopPropagation()
          cleanup()
        }

        window.addEventListener("pointermove", handleMove)
        window.addEventListener("pointerup", handleUp)
        window.addEventListener("keydown", handleKey, { capture: true })
      },
    }),
    [computeTarget, commitDrag, endDrag]
  )

  // ---- Keyboard pane navigation -------------------------------------------

  const focusPane = useCallback(
    (pane: string) => {
      setFocusedPane(pane)
      const el = pane === "main" ? mainRef.current : slotElsRef.current.get(pane)
      el?.focus({ preventScroll: true })
    },
    [setFocusedPane]
  )

  const cycleFocus = useCallback(
    (direction: 1 | -1) => {
      const sidePanes = paneZeroRef.current ? panesRef.current.slice(1) : panesRef.current
      const order = ["main", ...sidePanes]
      if (order.length < 2) return
      const idx = Math.max(0, order.indexOf(getFocusedPane()))
      focusPane(order[(idx + direction + order.length) % order.length])
    },
    [focusPane, getFocusedPane]
  )

  /** The focused pane's id in the combined order ("main" = pane 0). */
  const focusedPaneId = useCallback(() => {
    const focused = getFocusedPane()
    return focused === "main" ? paneZeroRef.current : focused
  }, [getFocusedPane])

  useKeyboardShortcuts(
    {
      focusNextPane: () => cycleFocus(1),
      focusPreviousPane: () => cycleFocus(-1),
      closeFocusedPanel: () => {
        const id = focusedPaneId()
        if (id) closePane(id)
        else if (panesRef.current.length > 0) closePanel()
      },
      movePanelLeft: () => {
        const id = focusedPaneId()
        if (!id) return
        const i = panesRef.current.indexOf(id)
        if (i > 0) {
          movePane(id, i - 1)
          setFocusedPane(id)
        }
      },
      movePanelRight: () => {
        const id = focusedPaneId()
        if (!id) return
        const i = panesRef.current.indexOf(id)
        if (i !== -1 && i < panesRef.current.length - 1) {
          movePane(id, i + 1)
          setFocusedPane(id)
        }
      },
    },
    !isMobile
  )

  // ---- Render --------------------------------------------------------------

  if (isMobile) {
    const top = panels.length > 0 ? panels[panels.length - 1] : null
    if (top) {
      return (
        <div className="flex h-full flex-col">
          <PanelInstanceProvider key={top} panelId={top}>
            <PanelContentRenderer panelId={top} workspaceId={workspaceId} onClose={() => closePanel(top)} />
          </PanelInstanceProvider>
        </div>
      )
    }
    return <>{children}</>
  }

  return (
    <div ref={containerRef} className="relative flex h-full min-w-0">
      <div
        ref={mainRef}
        tabIndex={-1}
        // flex-1 has basis 0 — without a min-width, enough panels would
        // squeeze the main view to nothing before the panels start shrinking.
        className="min-w-[360px] flex-1 outline-none"
        onPointerDownCapture={(e) => {
          setFocusedPane("main")
          // Pane 0 is a pane like any other — its page header doubles as the
          // drag handle. Only the topmost header counts; headers nested in
          // page content keep their own behavior.
          const paneZero = paneZeroRef.current
          if (!paneZero) return
          const target = e.target as HTMLElement
          const header = target.closest("header")
          if (!header || !mainRef.current) return
          const headerRect = header.getBoundingClientRect()
          const mainRect = mainRef.current.getBoundingClientRect()
          if (headerRect.top - mainRect.top > 8) return
          getDragHandleProps(paneZero).onPointerDown(e)
        }}
        onFocusCapture={() => setFocusedPane("main")}
      >
        {children}
      </div>

      {slots.map((slot) => (
        <PanelSlot
          key={slot.key}
          slotKey={slot.key}
          panelId={slot.id}
          closing={slot.closing}
          workspaceId={workspaceId}
          containerRef={containerRef}
          animateEntry={areaMountedRef.current}
          isDragSource={drag?.panelId === slot.id}
          dragHandleProps={getDragHandleProps(slot.id)}
          width={slotWidths[slot.key] ?? DEFAULT_PANEL_WIDTH}
          onWidthChange={setSlotWidth}
          onEqualizePair={equalizePairAt}
          onRegisterEl={registerSlotEl}
          onExited={handleSlotExited}
        />
      ))}

      {drag?.target && (
        <div
          className="pointer-events-none absolute z-50 rounded-lg border-2 border-primary/60 bg-primary/10 transition-all duration-150 ease-out"
          style={{
            left: drag.target.rect.left,
            top: drag.target.rect.top,
            width: drag.target.rect.width,
            height: drag.target.rect.height,
          }}
        />
      )}

      {drag && (
        <div
          className="pointer-events-none absolute z-50 max-w-[240px] truncate rounded-full border bg-background px-3 py-1 text-xs font-medium shadow-md"
          style={{ left: drag.x + 14, top: drag.y + 14 }}
        >
          {drag.title}
        </div>
      )}
    </div>
  )
}

interface PanelSlotProps {
  slotKey: string
  panelId: string
  closing: boolean
  workspaceId: string
  containerRef: React.RefObject<HTMLDivElement | null>
  animateEntry: boolean
  isDragSource: boolean
  dragHandleProps: { onPointerDown: (e: React.PointerEvent) => void }
  width: number
  onWidthChange: (slotKey: string, width: number) => void
  /** Double-click on the divider: equalize this pane with its left neighbor. */
  onEqualizePair: (slotKey: string) => void
  onRegisterEl: (panelId: string, el: HTMLDivElement | null) => void
  onExited: (slotKey: string) => void
}

function PanelSlot({
  slotKey,
  panelId,
  closing,
  workspaceId,
  containerRef,
  animateEntry,
  isDragSource,
  dragHandleProps,
  width,
  onWidthChange,
  onEqualizePair,
  onRegisterEl,
  onExited,
}: PanelSlotProps) {
  const { closePanel, setFocusedPane } = usePanel()
  const focusedPane = useFocusedPane()
  const [entered, setEntered] = useState(!animateEntry)
  const [slideDone, setSlideDone] = useState(!animateEntry)

  useEffect(() => {
    if (entered) return
    const frame = requestAnimationFrame(() => setEntered(true))
    return () => cancelAnimationFrame(frame)
  }, [entered])

  // Transition-end is the primary signal; the timeout is a fallback for the
  // cases where no width transition fires (e.g. closed before it entered).
  useEffect(() => {
    if (slideDone || closing) return
    const t = setTimeout(() => setSlideDone(true), SLIDE_MS * 2)
    return () => clearTimeout(t)
  }, [slideDone, closing])

  useEffect(() => {
    if (!closing) return
    const t = setTimeout(() => onExited(slotKey), SLIDE_MS * 2)
    return () => clearTimeout(t)
  }, [closing, onExited, slotKey])

  const handleTransitionEnd = useCallback(
    (e: React.TransitionEvent) => {
      if (e.propertyName !== "width" || e.target !== e.currentTarget) return
      if (closing) onExited(slotKey)
      else setSlideDone(true)
    },
    [closing, onExited, slotKey]
  )

  const handleWidthChange = useCallback(
    (newWidth: number) => {
      const containerWidth = containerRef.current?.offsetWidth ?? 0
      const maxWidth = Math.max(MIN_PANEL_WIDTH, Math.round(containerWidth * MAX_PANEL_RATIO))
      onWidthChange(slotKey, Math.max(MIN_PANEL_WIDTH, Math.min(maxWidth, newWidth)))
    },
    [containerRef, onWidthChange, slotKey]
  )

  const { isResizing, handleResizeStart } = useResizeDrag({
    width,
    onWidthChange: handleWidthChange,
    direction: "left",
  })

  const handleResizeKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const step = e.shiftKey ? 50 : 10
      if (e.key === "ArrowLeft") {
        e.preventDefault()
        handleWidthChange(width + step)
      } else if (e.key === "ArrowRight") {
        e.preventDefault()
        handleWidthChange(width - step)
      }
    },
    [width, handleWidthChange]
  )

  const maxWidth = Math.round((containerRef.current?.offsetWidth ?? 0) * MAX_PANEL_RATIO)
  const isFocused = !closing && focusedPane === panelId
  const isSliding = closing || !slideDone
  const displayWidth = closing || !entered ? 0 : width

  return (
    <div
      ref={(el) => {
        // Closing slots don't take part in drag targeting or keyboard focus —
        // a reopened twin must own the registration.
        if (!closing) onRegisterEl(panelId, el)
      }}
      data-testid="panel"
      data-panel-id={panelId}
      tabIndex={-1}
      // justify-end + a fixed-width inner box during the slide: the bounding
      // box animates, but the content is laid out at its final size and
      // slides in from the right edge. Content must never reshape while the
      // panel opens or closes.
      className={cn(
        "relative flex justify-end overflow-hidden outline-none",
        !isResizing && "transition-[width] duration-200 ease-out",
        isDragSource && "opacity-60"
      )}
      style={{ width: displayWidth, minWidth: isSliding ? 0 : Math.min(width, MIN_PANEL_WIDTH) }}
      onTransitionEnd={handleTransitionEnd}
      onPointerDownCapture={() => setFocusedPane(panelId)}
      onFocusCapture={() => setFocusedPane(panelId)}
    >
      <div
        className={cn("flex", !isSliding && "min-w-0 flex-1")}
        style={isSliding ? { width, minWidth: width, maxWidth: width } : undefined}
      >
        <PanelResizeHandle
          isResizing={isResizing}
          panelWidth={width}
          minWidth={MIN_PANEL_WIDTH}
          maxWidth={maxWidth}
          onMouseDown={handleResizeStart}
          onKeyDown={handleResizeKeyDown}
          onDoubleClick={() => onEqualizePair(slotKey)}
        />
        <div className="min-w-0 flex-1 overflow-hidden">
          <PanelInstanceProvider key={panelId} panelId={panelId} dragHandleProps={dragHandleProps}>
            <PanelContentRenderer panelId={panelId} workspaceId={workspaceId} onClose={() => closePanel(panelId)} />
          </PanelInstanceProvider>
        </div>
      </div>
      {/* Focus indicator: a hairline under the header of the focused panel. */}
      <div
        className={cn(
          "pointer-events-none absolute inset-x-0 top-0 z-10 h-12 border-b-2 border-primary/50 opacity-0 transition-opacity",
          isFocused && "opacity-100"
        )}
      />
    </div>
  )
}
