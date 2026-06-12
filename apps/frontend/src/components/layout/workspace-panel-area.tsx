import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import { useLocation, useNavigate } from "react-router-dom"
import { cn } from "@/lib/utils"
import { usePanel, useSidebar } from "@/contexts"
import { PanelInstanceProvider, useFocusedPane } from "@/contexts/panel-instance-context"
import { useKeyboardShortcuts } from "@/hooks"
import { useResizeDrag } from "@/hooks/use-resize-drag"
import { PanelContentRenderer } from "@/components/panels/panel-renderer"
import { panelIdToMainPath, mainPathToPanelId } from "@/components/panels/panel-locations"
import { PanelResizeHandle } from "./panel-resize-handle"

const DEFAULT_PANEL_WIDTH = 480
const MIN_PANEL_WIDTH = 300
const MAX_PANEL_RATIO = 0.6
/** Pointer must travel this far before a header-press becomes a drag. */
const DRAG_THRESHOLD_PX = 6
/** Right edge of the main view that acts as a "dock panel here" zone. */
const MAIN_EDGE_ZONE_PX = 120

interface OverlayRect {
  left: number
  top: number
  width: number
  height: number
}

type DropTarget = { kind: "insert"; index: number; rect: OverlayRect } | { kind: "main"; rect: OverlayRect }

interface DragState {
  panelId: string
  title: string
  /** Pointer position relative to the area container. */
  x: number
  y: number
  target: DropTarget | null
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
  const { panels, closePanel, movePanel, setFocusedPane, getFocusedPane } = usePanel()
  const { isMobile } = useSidebar()
  const navigate = useNavigate()
  const location = useLocation()

  const containerRef = useRef<HTMLDivElement>(null)
  const mainRef = useRef<HTMLDivElement>(null)
  const slotElsRef = useRef(new Map<string, HTMLDivElement>())

  // Slots that mount after the area itself animate open; slots present on
  // first paint (deep links) appear instantly.
  const areaMountedRef = useRef(false)
  useEffect(() => {
    areaMountedRef.current = true
  }, [])

  const registerSlotEl = useCallback((panelId: string, el: HTMLDivElement | null) => {
    if (el) slotElsRef.current.set(panelId, el)
    else slotElsRef.current.delete(panelId)
  }, [])

  // ---- Drag to reorder ----------------------------------------------------

  const [drag, setDrag] = useState<DragState | null>(null)
  const dragRef = useRef<DragState | null>(null)
  dragRef.current = drag
  const panelsRef = useRef(panels)
  panelsRef.current = panels
  const locationRef = useRef(location)
  locationRef.current = location

  const endDrag = useCallback(() => {
    setDrag(null)
    document.body.style.userSelect = ""
    document.body.style.cursor = ""
  }, [])

  const commitDrag = useCallback(
    (state: DragState) => {
      const target = state.target
      if (!target) return
      const currentPanels = panelsRef.current
      if (target.kind === "insert") {
        const from = currentPanels.indexOf(state.panelId)
        if (from === -1) return
        movePanel(state.panelId, from < target.index ? target.index - 1 : target.index)
        return
      }
      // Promote to main view; the previous main view takes over the vacated
      // slot when it has a panel-able equivalent (a swap), otherwise the slot
      // just closes.
      const mainPath = panelIdToMainPath(workspaceId, state.panelId)
      if (!mainPath) return
      const loc = locationRef.current
      const previousMain = mainPathToPanelId(loc.pathname)
      const params = new URLSearchParams(loc.search)
      const current = params.getAll("panel")
      params.delete("panel")
      for (const id of current) {
        if (id === state.panelId) {
          if (previousMain && previousMain !== state.panelId && !current.includes(previousMain)) {
            params.append("panel", previousMain)
          }
        } else {
          params.append("panel", id)
        }
      }
      const search = params.toString()
      navigate(`${mainPath}${search ? `?${search}` : ""}`)
    },
    [movePanel, navigate, workspaceId]
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

      const currentPanels = panelsRef.current
      const draggedIndex = currentPanels.indexOf(draggedId)

      for (let i = 0; i < currentPanels.length; i++) {
        const el = slotElsRef.current.get(currentPanels[i])
        if (!el) continue
        const r = el.getBoundingClientRect()
        if (clientX < r.left || clientX > r.right) continue
        const before = clientX < r.left + r.width / 2
        const index = before ? i : i + 1
        // Dropping back onto its own position is a no-op — no zone to show.
        if (index === draggedIndex || index === draggedIndex + 1) return null
        return {
          kind: "insert",
          index,
          rect: before
            ? rel(r.left, r.top, r.width / 2, r.height)
            : rel(r.left + r.width / 2, r.top, r.width / 2, r.height),
        }
      }

      const mainRect = main.getBoundingClientRect()
      if (clientX >= mainRect.left && clientX <= mainRect.right) {
        if (clientX > mainRect.right - MAIN_EDGE_ZONE_PX) {
          if (draggedIndex === 0) return null
          const stripWidth = Math.min(360, mainRect.width * 0.35)
          return {
            kind: "insert",
            index: 0,
            rect: rel(mainRect.right - stripWidth, mainRect.top, stripWidth, mainRect.height),
          }
        }
        if (!panelIdToMainPath(workspaceId, draggedId)) return null
        return {
          kind: "main",
          rect: rel(mainRect.left + 6, mainRect.top + 6, mainRect.width - 12, mainRect.height - 12),
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
            const headerEl = slotElsRef.current.get(panelId)?.querySelector("header")
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
      const order = ["main", ...panelsRef.current]
      if (order.length < 2) return
      const idx = Math.max(0, order.indexOf(getFocusedPane()))
      focusPane(order[(idx + direction + order.length) % order.length])
    },
    [focusPane, getFocusedPane]
  )

  useKeyboardShortcuts(
    {
      focusNextPane: () => cycleFocus(1),
      focusPreviousPane: () => cycleFocus(-1),
      closeFocusedPanel: () => {
        const focused = getFocusedPane()
        if (focused !== "main") closePanel(focused)
        else if (panelsRef.current.length > 0) closePanel()
      },
      movePanelLeft: () => {
        const focused = getFocusedPane()
        const i = panelsRef.current.indexOf(focused)
        if (i > 0) movePanel(focused, i - 1)
      },
      movePanelRight: () => {
        const focused = getFocusedPane()
        const i = panelsRef.current.indexOf(focused)
        if (i !== -1 && i < panelsRef.current.length - 1) movePanel(focused, i + 1)
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
        onPointerDownCapture={() => setFocusedPane("main")}
        onFocusCapture={() => setFocusedPane("main")}
      >
        {children}
      </div>

      {panels.map((panelId) => (
        <PanelSlot
          key={panelId}
          panelId={panelId}
          workspaceId={workspaceId}
          containerRef={containerRef}
          animateEntry={areaMountedRef.current}
          isDragSource={drag?.panelId === panelId}
          dragHandleProps={getDragHandleProps(panelId)}
          onRegisterEl={registerSlotEl}
        />
      ))}

      {drag?.target && (
        <div
          className="pointer-events-none absolute z-50 flex items-center justify-center rounded-lg border-2 border-primary/60 bg-primary/10 transition-all duration-150 ease-out"
          style={{
            left: drag.target.rect.left,
            top: drag.target.rect.top,
            width: drag.target.rect.width,
            height: drag.target.rect.height,
          }}
        >
          {drag.target.kind === "main" && (
            <span className="rounded-md bg-background/90 px-3 py-1.5 text-sm font-medium text-foreground shadow-sm">
              Open in main view
            </span>
          )}
        </div>
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
  panelId: string
  workspaceId: string
  containerRef: React.RefObject<HTMLDivElement | null>
  animateEntry: boolean
  isDragSource: boolean
  dragHandleProps: { onPointerDown: (e: React.PointerEvent) => void }
  onRegisterEl: (panelId: string, el: HTMLDivElement | null) => void
}

function PanelSlot({
  panelId,
  workspaceId,
  containerRef,
  animateEntry,
  isDragSource,
  dragHandleProps,
  onRegisterEl,
}: PanelSlotProps) {
  const { closePanel, setFocusedPane } = usePanel()
  const focusedPane = useFocusedPane()
  const [width, setWidth] = useState(DEFAULT_PANEL_WIDTH)
  const [entered, setEntered] = useState(!animateEntry)

  useEffect(() => {
    if (entered) return
    const frame = requestAnimationFrame(() => setEntered(true))
    return () => cancelAnimationFrame(frame)
  }, [entered])

  const handleWidthChange = useCallback(
    (newWidth: number) => {
      const containerWidth = containerRef.current?.offsetWidth ?? 0
      const maxWidth = Math.max(MIN_PANEL_WIDTH, Math.round(containerWidth * MAX_PANEL_RATIO))
      setWidth(Math.max(MIN_PANEL_WIDTH, Math.min(maxWidth, newWidth)))
    },
    [containerRef]
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
  const isFocused = focusedPane === panelId

  return (
    <div
      ref={(el) => onRegisterEl(panelId, el)}
      data-testid="panel"
      data-panel-id={panelId}
      tabIndex={-1}
      className={cn(
        "relative flex overflow-hidden outline-none",
        !isResizing && "transition-[width] duration-200 ease-out",
        isDragSource && "opacity-60"
      )}
      style={{ width: entered ? width : 0, minWidth: entered ? Math.min(width, MIN_PANEL_WIDTH) : 0 }}
      onPointerDownCapture={() => setFocusedPane(panelId)}
      onFocusCapture={() => setFocusedPane(panelId)}
    >
      <PanelResizeHandle
        isResizing={isResizing}
        panelWidth={width}
        minWidth={MIN_PANEL_WIDTH}
        maxWidth={maxWidth}
        onMouseDown={handleResizeStart}
        onKeyDown={handleResizeKeyDown}
      />
      <div className="min-w-0 flex-1 overflow-hidden">
        <PanelInstanceProvider panelId={panelId} dragHandleProps={dragHandleProps}>
          <PanelContentRenderer panelId={panelId} workspaceId={workspaceId} onClose={() => closePanel(panelId)} />
        </PanelInstanceProvider>
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
