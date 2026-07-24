import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react"
import { GripHorizontal, Maximize2, Minimize2, PanelRight } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { useStreamName } from "@/hooks/use-stream-name"
import { useWorkspaceUserId } from "@/hooks/use-workspaces"
import { CallJoiningBody } from "./pre-join-gate"
import { CallTile } from "./call-tile"
import { CallControls } from "./call-controls"
import { CallTimer } from "./call-timer"
import { CameraButton, LeaveButton, MuteButton } from "./call-control-buttons"
import { CaptureErrorBanner } from "./call-capture-error"
import { useCallCaptureError, useCallConnectedAt, useCallPhase, useCallRoster } from "./call-store-hooks"
import {
  anchorSurfaceAtPointer,
  clampSquareToViewport,
  CALL_SURFACE_PROTECTED_ATTR,
  type FloatingSurfaceGeometry,
  type Point,
  type Rect,
  type Size,
} from "./call-surface-geometry"
import { publishFloatingSurfaceGeometry } from "@/stores/floating-surface-geometry-store"

const REDUCED_MOTION =
  typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches

const SQUARE_WIDTH = 340
const MARGIN = 8
// Initial-anchor height estimate before the square measures itself; the mount
// reclamp refines it against the real `offsetHeight`.
const NOMINAL_HEIGHT = 320
const MINIMIZED_SIZE = { width: 280, height: 50 }
const MINIMIZED_POINTER_ANCHOR = { x: MINIMIZED_SIZE.width - 24, y: MINIMIZED_SIZE.height / 2 }
const KEYBOARD_MOVE_STEP = 16

function defaultAnchor(): Point {
  const vw = typeof window !== "undefined" ? window.innerWidth : 1024
  const vh = typeof window !== "undefined" ? window.innerHeight : 768
  return clampSquareToViewport(
    { x: vw - SQUARE_WIDTH - MARGIN, y: vh - NOMINAL_HEIGHT - MARGIN },
    { width: SQUARE_WIDTH, height: NOMINAL_HEIGHT },
    { width: vw, height: vh },
    MARGIN
  )
}

function toRect(box: DOMRect): Rect {
  return { x: box.left, y: box.top, width: box.width, height: box.height }
}

/**
 * Measure the surface and every interactive group inside it, in viewport
 * coordinates. Measured boxes are authoritative: they already carry any
 * transform/zoom the ring's own `getBoundingClientRect` sees, so both sides
 * compare like with like. jsdom lays nothing out and reports an all-zero box,
 * hence the caller-supplied fallback for the root; zero-sized groups drop out
 * rather than scoring as a point obstacle.
 */
function measureSurfaceGeometry(root: HTMLElement, fallbackRect: Rect): FloatingSurfaceGeometry {
  const box = root.getBoundingClientRect()
  const groups: Element[] = [...root.querySelectorAll(`[${CALL_SURFACE_PROTECTED_ATTR}]`)]
  if (root.hasAttribute(CALL_SURFACE_PROTECTED_ATTR)) groups.unshift(root)
  return {
    rect: box.width > 0 && box.height > 0 ? toRect(box) : fallbackRect,
    protectedRects: groups
      .map((group) => group.getBoundingClientRect())
      .filter((groupBox) => groupBox.width > 0 && groupBox.height > 0)
      .map(toRect),
  }
}

interface DragState {
  pointerId: number
  startX: number
  startY: number
  originX: number
  originY: number
}

function SquareHeader({
  title,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onDockToSide,
  onMinimize,
  minimizeRef,
  canMinimize,
  dragging,
}: {
  title: string
  onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void
  onPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => void
  onPointerUp: (e: ReactPointerEvent<HTMLDivElement>) => void
  onDockToSide: () => void
  onMinimize: (e: ReactMouseEvent<HTMLButtonElement>) => void
  minimizeRef: RefObject<HTMLButtonElement | null>
  // Only a connected call may minimize — collapsing the joining/pre-join window would
  // hide the PreJoinGate permission taxonomy (mirrors call-dock.tsx's force-open guard).
  canMinimize: boolean
  dragging: boolean
}) {
  return (
    <div
      data-testid="floating-call-square-header"
      // The whole header is protected, not just the action pair: the grip, the
      // title and the empty space between them are the drag surface, so a ring
      // lying across them is as unusable as one lying across the buttons.
      {...{ [CALL_SURFACE_PROTECTED_ATTR]: "" }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      className={cn(
        "flex shrink-0 touch-none items-center gap-2 border-b px-3 py-2",
        dragging ? "cursor-grabbing" : "cursor-grab"
      )}
    >
      <GripHorizontal
        data-testid="expanded-call-drag-grip"
        className="h-4 w-4 shrink-0 text-muted-foreground"
        aria-hidden
      />
      <span className="min-w-0 flex-1 truncate text-sm font-medium">{title}</span>
      <button
        type="button"
        aria-label="Dock to the side"
        title="Dock to the side"
        onClick={onDockToSide}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <PanelRight className="h-4 w-4" />
      </button>
      {canMinimize && (
        <button
          ref={minimizeRef}
          type="button"
          aria-label="Minimize call"
          onClick={onMinimize}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <Minimize2 className="h-4 w-4" />
        </button>
      )}
    </div>
  )
}

function ConnectedBody({
  workspaceId,
  currentUserId,
  roster,
  captureError,
}: {
  workspaceId: string | null
  currentUserId: string | null
  roster: ReturnType<typeof useCallRoster>
  captureError: ReturnType<typeof useCallCaptureError>
}) {
  const joined = roster.filter((p) => p.participantStatus === "joined")
  return (
    <>
      {captureError && <CaptureErrorBanner error={captureError} className="mx-3 mt-2" />}
      <div
        className={cn(
          "grid min-h-0 flex-1 gap-2 overflow-y-auto p-3",
          joined.length > 1 ? "grid-cols-2" : "grid-cols-1"
        )}
      >
        {joined.map((p) => (
          <CallTile
            key={p.userId}
            participant={p}
            workspaceId={workspaceId}
            isSelf={!!currentUserId && p.userId === currentUserId}
          />
        ))}
      </div>
      <div className="shrink-0 border-t p-2">
        <CallControls />
      </div>
    </>
  )
}

function MinimizedBar({
  surfaceRef,
  pos,
  connectedAt,
  dragging,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onMoveKeyDown,
  onRestore,
  restoreRef,
}: {
  surfaceRef: (node: HTMLDivElement | null) => void
  pos: Point
  connectedAt: number | null
  dragging: boolean
  onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void
  onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void
  onPointerUp: (e: ReactPointerEvent<HTMLElement>) => void
  onMoveKeyDown: (e: ReactKeyboardEvent<HTMLButtonElement>) => void
  onRestore: () => void
  restoreRef: RefObject<HTMLButtonElement | null>
}) {
  return (
    <div
      ref={surfaceRef}
      data-testid="floating-call-square"
      data-minimized="true"
      {...{ [CALL_SURFACE_PROTECTED_ATTR]: "" }}
      style={{ left: `${pos.x}px`, top: `${pos.y}px`, width: `${MINIMIZED_SIZE.width}px` }}
      className="pointer-events-auto fixed z-50 flex items-center gap-1 rounded-xl border bg-background p-1.5 shadow-xl"
    >
      <Button
        type="button"
        variant="ghost"
        size="icon"
        data-call-drag-handle
        data-testid="minimized-call-drag-handle"
        aria-label="Move minimized call with arrow keys"
        aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight"
        title="Drag or use arrow keys to move"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onMoveKeyDown}
        className={cn(
          "h-9 w-9 shrink-0 touch-none text-muted-foreground",
          dragging ? "cursor-grabbing" : "cursor-grab"
        )}
      >
        <GripHorizontal className="h-3.5 w-3.5 rotate-90" aria-hidden />
      </Button>
      <div className="flex min-w-0 flex-1 items-center gap-1" data-testid="minimized-call-content">
        <span
          className={cn("h-2 w-2 shrink-0 rounded-full bg-primary", !REDUCED_MOTION && "animate-pulse")}
          aria-hidden
        />
        <CallTimer connectedAt={connectedAt} className="mr-auto text-xs" />
        <div className="flex shrink-0 items-center gap-1" data-testid="minimized-call-controls">
          <MuteButton />
          <CameraButton />
          <LeaveButton />
        </div>
      </div>
      <Button
        ref={restoreRef}
        type="button"
        variant="ghost"
        size="icon"
        aria-label="Restore call"
        onClick={onRestore}
        className="h-9 w-9 shrink-0"
      >
        <Maximize2 className="h-4 w-4" aria-hidden />
      </Button>
    </div>
  )
}

/**
 * A draggable, minimizable floating desktop call surface: header (drag / dock-to-
 * side / minimize) plus the phase body — connected tiles + {@link CallControls}, or
 * the "Connecting…" indicator / {@link PreJoinGate}. A LIGHT panel (not the dark mobile
 * island). Position lives in local state, committed through {@link clampSquareToViewport}
 * on drag and reclamped on window resize so it never leaves the viewport. Minimize is
 * connected-only, so the compact bar never hides the joining gate.
 */
export function FloatingCallSquare({
  workspaceId,
  streamId,
  onDockToSide,
}: {
  workspaceId: string | null
  streamId: string | null
  onDockToSide: () => void
}) {
  const phase = useCallPhase()
  const roster = useCallRoster()
  const connectedAt = useCallConnectedAt()
  const captureError = useCallCaptureError()
  const currentUserId = useWorkspaceUserId(workspaceId ?? "")
  const name = useStreamName(workspaceId ?? "", streamId ?? "", "generic")
  const title = name ?? "Call"

  const inCall = phase === "connected" || phase === "reconnecting"

  const surfaceRef = useRef<HTMLDivElement | null>(null)
  // Node in state, not just a ref: the observers below must re-attach when
  // minimize/restore swaps the root element out for a different one.
  const [surfaceNode, setSurfaceNode] = useState<HTMLDivElement | null>(null)
  const attachSurface = useCallback((node: HTMLDivElement | null) => {
    surfaceRef.current = node
    setSurfaceNode(node)
  }, [])
  const minimizeButtonRef = useRef<HTMLButtonElement>(null)
  const restoreButtonRef = useRef<HTMLButtonElement>(null)
  const pendingFocus = useRef<"minimize" | "restore" | null>(null)
  const drag = useRef<DragState | null>(null)
  const [pos, setPos] = useState<Point>(() => defaultAnchor())
  const [dragging, setDragging] = useState(false)
  const [minimized, setMinimized] = useState(false)

  const getSurfaceSize = useCallback((): Size => {
    const el = surfaceRef.current
    return {
      width: el?.offsetWidth || (minimized ? MINIMIZED_SIZE.width : SQUARE_WIDTH),
      height: el?.offsetHeight || (minimized ? MINIMIZED_SIZE.height : NOMINAL_HEIGHT),
    }
  }, [minimized])

  const reclamp = useCallback(() => {
    const viewport = { width: window.innerWidth, height: window.innerHeight }
    setPos((prev) => clampSquareToViewport(prev, getSurfaceSize(), viewport, MARGIN))
  }, [getSurfaceSize])

  useLayoutEffect(() => {
    reclamp()
  }, [reclamp])

  const posRef = useRef(pos)
  posRef.current = pos

  const publishGeometry = useCallback(() => {
    const root = surfaceRef.current
    if (!root) return
    const fallback = { x: posRef.current.x, y: posRef.current.y, ...getSurfaceSize() }
    publishFloatingSurfaceGeometry(measureSurfaceGeometry(root, fallback))
  }, [getSurfaceSize])

  // Publish on every render — position, minimize and content-driven size changes
  // all land here — so the incoming-ring overlay can avoid the surface.
  useLayoutEffect(publishGeometry)

  // ...but the phase body is a child that owns its own state: a PreJoinGate going
  // requesting → permission_error changes which controls exist, and where, without
  // rerendering this component. Observe the subtree so those republish too.
  // Attributes are filtered to `class`: a control group can move or disappear by
  // class alone (hidden/size utilities) with no childList change, while a drag
  // rewrites the root's inline style every frame and already republishes through
  // the render above — observing all attributes would republish per drag frame.
  useEffect(() => {
    if (!surfaceNode) return
    const mutations = new MutationObserver(publishGeometry)
    mutations.observe(surfaceNode, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] })
    const resizes = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(publishGeometry)
    resizes?.observe(surfaceNode)
    return () => {
      mutations.disconnect()
      resizes?.disconnect()
    }
  }, [surfaceNode, publishGeometry])

  // Layout-effect cleanup, not an effect: the ring must lose the obstacle in the
  // same commit the square unmounts, or it paints one frame still translated.
  useLayoutEffect(() => () => publishFloatingSurfaceGeometry(null), [])

  useEffect(() => {
    const handleResize = () => {
      drag.current = null
      setDragging(false)
      reclamp()
    }
    window.addEventListener("resize", handleResize)
    return () => window.removeEventListener("resize", handleResize)
  }, [reclamp])

  // Never stay minimized outside a connected call — the compact bar would hide the joining
  // PreJoinGate and imply "live" with a 0:00 timer (mirrors call-dock.tsx's force-open).
  useEffect(() => {
    if (!inCall) setMinimized(false)
  }, [inCall])

  useEffect(() => {
    if (pendingFocus.current === "restore" && minimized) restoreButtonRef.current?.focus()
    if (pendingFocus.current === "minimize" && !minimized) minimizeButtonRef.current?.focus()
    pendingFocus.current = null
  }, [minimized])

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    if (!e.isPrimary) return
    const actionButton = (e.target as HTMLElement).closest("button")
    if (actionButton && !actionButton.hasAttribute("data-call-drag-handle")) return
    drag.current = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, originX: pos.x, originY: pos.y }
    e.currentTarget.setPointerCapture(e.pointerId)
    setDragging(true)
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current
    if (!d || e.pointerId !== d.pointerId) return
    const viewport = { width: window.innerWidth, height: window.innerHeight }
    const next = { x: d.originX + (e.clientX - d.startX), y: d.originY + (e.clientY - d.startY) }
    setPos(clampSquareToViewport(next, getSurfaceSize(), viewport, MARGIN))
  }

  const onPointerUp = () => {
    drag.current = null
    setDragging(false)
  }

  const moveMinimizedWithKeyboard = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    let delta: Point
    switch (e.key) {
      case "ArrowLeft":
        delta = { x: -KEYBOARD_MOVE_STEP, y: 0 }
        break
      case "ArrowRight":
        delta = { x: KEYBOARD_MOVE_STEP, y: 0 }
        break
      case "ArrowUp":
        delta = { x: 0, y: -KEYBOARD_MOVE_STEP }
        break
      case "ArrowDown":
        delta = { x: 0, y: KEYBOARD_MOVE_STEP }
        break
      default:
        return
    }
    e.preventDefault()
    const viewport = { width: window.innerWidth, height: window.innerHeight }
    setPos((prev) =>
      clampSquareToViewport({ x: prev.x + delta.x, y: prev.y + delta.y }, MINIMIZED_SIZE, viewport, MARGIN)
    )
  }

  const minimizeAtPointer = (e: ReactMouseEvent<HTMLButtonElement>) => {
    pendingFocus.current = "restore"
    const viewport = { width: window.innerWidth, height: window.innerHeight }
    setPos((prev) =>
      e.detail > 0
        ? anchorSurfaceAtPointer(
            { x: e.clientX, y: e.clientY },
            MINIMIZED_SIZE,
            viewport,
            MINIMIZED_POINTER_ANCHOR,
            MARGIN
          )
        : clampSquareToViewport(prev, MINIMIZED_SIZE, viewport, MARGIN)
    )
    setMinimized(true)
  }

  const restoreFromMinimized = () => {
    pendingFocus.current = "minimize"
    setMinimized(false)
  }

  if (minimized) {
    return (
      <MinimizedBar
        surfaceRef={attachSurface}
        pos={pos}
        connectedAt={connectedAt}
        dragging={dragging}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onMoveKeyDown={moveMinimizedWithKeyboard}
        onRestore={restoreFromMinimized}
        restoreRef={restoreButtonRef}
      />
    )
  }

  return (
    <div
      ref={attachSurface}
      data-testid="floating-call-square"
      data-minimized="false"
      style={{ left: `${pos.x}px`, top: `${pos.y}px`, width: `${SQUARE_WIDTH}px` }}
      className="pointer-events-auto fixed z-50 flex min-h-[260px] max-h-[70vh] flex-col overflow-hidden rounded-lg border bg-background shadow-xl"
    >
      <SquareHeader
        title={title}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDockToSide={onDockToSide}
        onMinimize={minimizeAtPointer}
        minimizeRef={minimizeButtonRef}
        canMinimize={inCall}
        dragging={dragging}
      />
      {inCall ? (
        <ConnectedBody
          workspaceId={workspaceId}
          currentUserId={currentUserId}
          roster={roster}
          captureError={captureError}
        />
      ) : (
        <CallJoiningBody />
      )}
    </div>
  )
}
