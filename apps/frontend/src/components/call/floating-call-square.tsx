import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react"
import { GripHorizontal, Minimize2, PanelRight } from "lucide-react"
import { cn } from "@/lib/utils"
import { useStreamName } from "@/hooks/use-stream-name"
import { useWorkspaceUserId } from "@/hooks/use-workspaces"
import { useCallLaunch } from "./call-launch-context"
import { PreJoinGate } from "./pre-join-gate"
import { CallTile } from "./call-tile"
import { CallControls } from "./call-controls"
import { CallTimer } from "./call-timer"
import { CaptureErrorBanner } from "./call-capture-error"
import { useCallCaptureError, useCallConnectedAt, useCallPhase, useCallRoster } from "./call-store-hooks"

const REDUCED_MOTION =
  typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches

const SQUARE_WIDTH = 340
const MARGIN = 8
// Initial-anchor height estimate before the square measures itself; the mount
// reclamp refines it against the real `offsetHeight`.
const NOMINAL_HEIGHT = 320

interface Point {
  x: number
  y: number
}

interface Size {
  width: number
  height: number
}

/**
 * Clamp a floating square so it stays fully on-screen with `margin` padding. When
 * the square is larger than the viewport the upper bound would go negative, so it
 * floors at `margin` (top-left pinned) rather than clamping to a negative x/y.
 */
export function clampSquareToViewport(pos: Point, size: Size, viewport: Size, margin = 8): Point {
  const maxX = Math.max(margin, viewport.width - size.width - margin)
  const maxY = Math.max(margin, viewport.height - size.height - margin)
  return {
    x: Math.min(Math.max(pos.x, margin), maxX),
    y: Math.min(Math.max(pos.y, margin), maxY),
  }
}

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
  canMinimize,
  dragging,
}: {
  title: string
  onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void
  onPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => void
  onPointerUp: (e: ReactPointerEvent<HTMLDivElement>) => void
  onDockToSide: () => void
  onMinimize: () => void
  // Only a connected call may minimize — collapsing the joining/pre-join window would
  // hide the PreJoinGate permission taxonomy (mirrors call-dock.tsx's force-open guard).
  canMinimize: boolean
  dragging: boolean
}) {
  return (
    <div
      data-testid="floating-call-square-header"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      className={cn(
        "flex shrink-0 touch-none items-center gap-2 border-b px-3 py-2",
        dragging ? "cursor-grabbing" : "cursor-grab"
      )}
    >
      <GripHorizontal className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 flex-1 truncate text-sm font-medium">{title}</span>
      <button
        type="button"
        aria-label="Dock to the side"
        onClick={onDockToSide}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <PanelRight className="h-4 w-4" />
      </button>
      {canMinimize && (
        <button
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

/**
 * Joining/pre-join body — the desktop joining surface, mirroring
 * {@link import("./call-dock").CallDock}'s DockFrame: an active launch (permission
 * request / device pick / error) shows the {@link PreJoinGate}; once the launch is
 * idle and the call is connecting, a plain "Connecting…" indicator.
 */
function JoiningBody() {
  const { state } = useCallLaunch()
  if (state.status !== "idle") {
    return (
      <div className="p-3">
        <PreJoinGate />
      </div>
    )
  }
  return <div className="flex items-center justify-center py-6 text-sm text-muted-foreground">Connecting…</div>
}

function MinimizedBubble({
  pos,
  connectedAt,
  onRestore,
}: {
  pos: Point
  connectedAt: number | null
  onRestore: () => void
}) {
  return (
    <button
      type="button"
      data-testid="floating-call-square"
      data-minimized="true"
      aria-label="Restore call"
      onClick={onRestore}
      style={{ left: `${pos.x}px`, top: `${pos.y}px` }}
      className="pointer-events-auto fixed z-50 flex items-center gap-2 rounded-full border bg-background px-3 py-2 shadow-xl"
    >
      <span
        className={cn("h-2 w-2 shrink-0 rounded-full bg-primary", !REDUCED_MOTION && "animate-pulse")}
        aria-hidden
      />
      <CallTimer connectedAt={connectedAt} className="text-xs" />
    </button>
  )
}

/**
 * A draggable, minimizable floating desktop call surface: header (drag / dock-to-
 * side / minimize) plus the phase body — connected tiles + {@link CallControls}, or
 * the "Connecting…" indicator / {@link PreJoinGate}. A LIGHT panel (not the dark mobile
 * island). Position lives in local state, committed through {@link clampSquareToViewport}
 * on drag and reclamped on window resize so it never leaves the viewport. Minimize is
 * connected-only, so a bubble never hides the joining gate.
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

  const squareRef = useRef<HTMLDivElement>(null)
  const drag = useRef<DragState | null>(null)
  const [pos, setPos] = useState<Point>(() => defaultAnchor())
  const [dragging, setDragging] = useState(false)
  const [minimized, setMinimized] = useState(false)

  const reclamp = useCallback(() => {
    const el = squareRef.current
    const size = { width: el?.offsetWidth || SQUARE_WIDTH, height: el?.offsetHeight || 0 }
    const viewport = { width: window.innerWidth, height: window.innerHeight }
    setPos((prev) => clampSquareToViewport(prev, size, viewport, MARGIN))
  }, [])

  useEffect(() => {
    reclamp()
    window.addEventListener("resize", reclamp)
    return () => window.removeEventListener("resize", reclamp)
  }, [reclamp])

  // Never stay minimized outside a connected call — a bubble would hide the joining
  // PreJoinGate and imply "live" with a 0:00 timer (mirrors call-dock.tsx's force-open).
  useEffect(() => {
    if (!inCall) setMinimized(false)
  }, [inCall])

  // Restoring measures the full square (the bubble carries no ref, so a resize while
  // minimized couldn't reclamp it) — pull it back on-screen if the window shrank.
  useEffect(() => {
    if (!minimized) reclamp()
  }, [minimized, reclamp])

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    // Primary pointer only; the header's action buttons aren't drag handles.
    if (!e.isPrimary) return
    if ((e.target as HTMLElement).closest("button")) return
    drag.current = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, originX: pos.x, originY: pos.y }
    e.currentTarget.setPointerCapture(e.pointerId)
    setDragging(true)
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d || e.pointerId !== d.pointerId) return
    const el = squareRef.current
    const size = { width: el?.offsetWidth || SQUARE_WIDTH, height: el?.offsetHeight || 0 }
    const viewport = { width: window.innerWidth, height: window.innerHeight }
    const next = { x: d.originX + (e.clientX - d.startX), y: d.originY + (e.clientY - d.startY) }
    setPos(clampSquareToViewport(next, size, viewport, MARGIN))
  }

  const onPointerUp = () => {
    drag.current = null
    setDragging(false)
  }

  if (minimized) {
    return <MinimizedBubble pos={pos} connectedAt={connectedAt} onRestore={() => setMinimized(false)} />
  }

  return (
    <div
      ref={squareRef}
      data-testid="floating-call-square"
      data-minimized="false"
      style={{ left: `${pos.x}px`, top: `${pos.y}px`, width: `${SQUARE_WIDTH}px` }}
      className="pointer-events-auto fixed z-50 flex max-h-[70vh] flex-col overflow-hidden rounded-lg border bg-background shadow-xl"
    >
      <SquareHeader
        title={title}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDockToSide={onDockToSide}
        onMinimize={() => setMinimized(true)}
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
        <JoiningBody />
      )}
    </div>
  )
}
