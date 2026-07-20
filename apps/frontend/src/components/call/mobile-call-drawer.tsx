import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react"
import { ChevronUp } from "lucide-react"
import { cn } from "@/lib/utils"
import { useStreamName } from "@/hooks/use-stream-name"
import { useWorkspaceUserId } from "@/hooks/use-workspaces"
import { useWorkspaceUsers } from "@/stores/workspace-store"
import {
  setCallSurfaceMode,
  type CallCaptureErrorInfo,
  type CallRosterParticipant,
  type CallSurfaceMode,
} from "@/stores/call-store"
import { CallTile } from "./call-tile"
import { CallControls } from "./call-controls"
import { CameraButton, LeaveButton, MuteButton } from "./call-control-buttons"
import { useCallCaptureError, useCallConnectedAt, useCallRoster, useCallSurfaceMode } from "./call-store-hooks"
import { DRAWER_MIN_HEIGHT, nearestMode } from "./mobile-call-drawer-snap"

const REDUCED_MOTION =
  typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches

/** Per-mode frame classes (width/border/radius); `min` is the floating pill, the rest are full-width. */
const FRAME_CLASS: Record<CallSurfaceMode, string> = {
  min: "w-fit rounded-b-2xl border border-t-0",
  compact: "w-full border-b",
  standard: "w-full border-b",
  full: "w-full",
}

/** Resting CSS height per mode; `min` is the intrinsic pill, `full` fills below the status bar. */
const RESTING_HEIGHT: Record<CallSurfaceMode, string> = {
  min: "auto",
  compact: "80px",
  standard: "248px",
  full: "calc(100dvh - env(safe-area-inset-top))",
}

function viewportHeight(): number {
  if (typeof window === "undefined") return DRAWER_MIN_HEIGHT
  return window.visualViewport?.height ?? window.innerHeight
}

/** mm:ss, or h:mm:ss past an hour. */
function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m)
  const ss = String(s).padStart(2, "0")
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

function CallTimer({ connectedAt, className }: { connectedAt: number | null; className?: string }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])
  const elapsed = connectedAt == null ? 0 : now - connectedAt
  return (
    <span className={cn("font-mono text-sm tabular-nums", className)} aria-label="Call duration">
      {formatElapsed(elapsed)}
    </span>
  )
}

function captureErrorText(code: CallCaptureErrorInfo["code"]): string {
  return code === "capture_rollback_failed"
    ? "Your microphone stopped working and couldn't be restored. Try leaving and rejoining."
    : "Couldn't switch your microphone or camera. Your previous device is still active."
}

function CaptureErrorBanner({ error }: { error: CallCaptureErrorInfo }) {
  return (
    <p
      className="mx-3 mt-2 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive"
      role="alert"
      data-testid="call-capture-error"
    >
      {captureErrorText(error.code)}
    </p>
  )
}

function GrabHandle({
  onPointerDown,
  onPointerMove,
  onPointerUp,
}: {
  onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void
  onPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => void
  onPointerUp: (e: ReactPointerEvent<HTMLDivElement>) => void
}) {
  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize call"
      data-testid="call-drawer-handle"
      className="flex shrink-0 touch-none cursor-grab items-center justify-center py-2 active:cursor-grabbing"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <span className="h-1 w-10 rounded-full bg-muted-foreground/40" aria-hidden />
    </div>
  )
}

interface ViewProps {
  workspaceId: string | null
  connectedAt: number | null
  currentUserId: string | null
  roster: CallRosterParticipant[]
  speakerName: string | null
  title: string
}

function TabView({
  connectedAt,
  captureError,
}: {
  connectedAt: number | null
  captureError: CallCaptureErrorInfo | null
}) {
  return (
    <button
      type="button"
      aria-label="Expand call"
      onClick={() => setCallSurfaceMode("compact")}
      className="flex items-center justify-center gap-2 px-4 py-1.5"
    >
      {captureError ? (
        <span
          className="h-2 w-2 shrink-0 rounded-full bg-destructive"
          role="alert"
          data-testid="call-capture-error"
          aria-label="Microphone or camera problem — expand the call to see details"
        />
      ) : (
        <span
          className={cn("h-2 w-2 shrink-0 rounded-full bg-primary", !REDUCED_MOTION && "animate-pulse")}
          aria-hidden
        />
      )}
      <CallTimer connectedAt={connectedAt} />
    </button>
  )
}

function BarView({ connectedAt, speakerName }: ViewProps) {
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <div className="flex min-w-0 flex-1 flex-col">
        <CallTimer connectedAt={connectedAt} />
        {speakerName && <span className="truncate text-xs text-muted-foreground">{speakerName}</span>}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <MuteButton />
        <CameraButton />
        <LeaveButton />
      </div>
    </div>
  )
}

function TinyGalleryView({ workspaceId, connectedAt, currentUserId, roster, speakerName }: ViewProps) {
  const joined = roster.filter((p) => p.participantStatus === "joined")
  const self = joined.find((p) => p.userId === currentUserId) ?? null
  const peer = joined.find((p) => p.userId !== currentUserId) ?? null
  const tiles = [peer, self].filter((p): p is CallRosterParticipant => p !== null)

  return (
    <div className="flex h-full flex-col gap-2 p-3">
      <div className="flex flex-col">
        <CallTimer connectedAt={connectedAt} />
        {speakerName && <span className="truncate text-xs text-muted-foreground">{speakerName}</span>}
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-2 gap-2 overflow-hidden">
        {tiles.map((p) => (
          <div key={p.userId} className={cn("min-h-0", p === peer && "rounded-md ring-2 ring-primary")}>
            <CallTile participant={p} workspaceId={workspaceId} isSelf={p.userId === currentUserId} stage />
          </div>
        ))}
      </div>
      <div className="shrink-0">
        <CallControls />
      </div>
    </div>
  )
}

/** Draggable self-view PiP, constrained to the stage. Defaults to the top-right. */
function SelfPip({ participant, workspaceId }: { participant: CallRosterParticipant; workspaceId: string | null }) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const drag = useRef<{ dx: number; dy: number } | null>(null)

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect()
    drag.current = { dx: e.clientX - box.left, dy: e.clientY - box.top }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current
    const stage = e.currentTarget.parentElement
    if (!d || !stage) return
    const bounds = stage.getBoundingClientRect()
    const box = e.currentTarget.getBoundingClientRect()
    const x = Math.min(Math.max(e.clientX - d.dx - bounds.left, 0), Math.max(bounds.width - box.width, 0))
    const y = Math.min(Math.max(e.clientY - d.dy - bounds.top, 0), Math.max(bounds.height - box.height, 0))
    setPos({ x, y })
  }
  const onPointerUp = () => {
    drag.current = null
  }

  return (
    <div
      className="absolute h-24 w-16 touch-none overflow-hidden rounded-lg shadow-lg"
      style={pos ? { left: pos.x, top: pos.y } : { right: 12, top: 12 }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      data-testid="call-self-pip"
    >
      <CallTile participant={participant} workspaceId={workspaceId} isSelf stage fill />
    </div>
  )
}

function FullscreenView({ workspaceId, connectedAt, currentUserId, roster, title }: ViewProps) {
  const joined = roster.filter((p) => p.participantStatus === "joined")
  const self = joined.find((p) => p.userId === currentUserId) ?? null
  const peer = joined.find((p) => p.userId !== currentUserId) ?? null
  const pinned = peer ?? self
  const selfPip = self && self !== pinned ? self : null
  const filmstrip = joined.filter((p) => p !== pinned && p !== selfPip)

  return (
    <div className="flex h-full flex-col bg-call-stage text-white">
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          aria-label="Collapse call"
          onClick={() => setCallSurfaceMode("standard")}
          className="flex h-9 w-9 items-center justify-center rounded-md text-white/80 hover:bg-white/10 hover:text-white"
        >
          <ChevronUp className="h-5 w-5" />
        </button>
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-medium">{title}</span>
          <CallTimer connectedAt={connectedAt} className="text-white/70" />
        </div>
        {/* ch5 seam: <LayoutToggle/> (Speaker/Grid) mounts here and switches the stage
            between this speaker+filmstrip layout and an equal-tile Grid. */}
        <div data-testid="call-layout-slot" className="ml-auto" />
      </div>

      <div className="relative min-h-0 flex-1">
        {pinned && (
          <CallTile
            participant={pinned}
            workspaceId={workspaceId}
            isSelf={pinned.userId === currentUserId}
            stage
            fill
          />
        )}
        {selfPip && <SelfPip participant={selfPip} workspaceId={workspaceId} />}
      </div>

      {filmstrip.length > 0 && (
        <div className="flex shrink-0 gap-2 overflow-x-auto px-3 py-2">
          {filmstrip.map((p) => (
            <div key={p.userId} className="h-20 w-32 shrink-0">
              <CallTile participant={p} workspaceId={workspaceId} isSelf={p.userId === currentUserId} stage fill />
            </div>
          ))}
        </div>
      )}

      <div className="shrink-0 px-3 pb-3 pt-1">
        <CallControls />
      </div>
    </div>
  )
}

/**
 * The mobile in-call surface: a global top drawer that snaps through four modes
 * (Tab → Bar → Tiny gallery → Fullscreen) driven by `surfaceMode`. Rendered by
 * {@link CallDock} only on a mobile viewport for the connected phase; it reads the
 * call store, not the route, so the Tab stays visible across stream navigation.
 * Desktop keeps the existing dock (chunk 6 replaces it).
 */
export function MobileCallDrawer({ workspaceId, streamId }: { workspaceId: string | null; streamId: string | null }) {
  const surfaceMode = useCallSurfaceMode()
  const roster = useCallRoster()
  const connectedAt = useCallConnectedAt()
  const captureError = useCallCaptureError()
  const currentUserId = useWorkspaceUserId(workspaceId ?? "")
  const users = useWorkspaceUsers(workspaceId ?? undefined)
  const name = useStreamName(workspaceId ?? "", streamId ?? "", "generic")
  const title = name ?? "Call"

  const drawerRef = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState(false)
  const [dragHeight, setDragHeight] = useState<number | null>(null)
  const drag = useRef<{
    startY: number
    startHeight: number
    height: number
    velocity: number
    lastY: number
    lastT: number
  } | null>(null)

  const contentMode: CallSurfaceMode = dragging && dragHeight != null ? nearestMode(dragHeight, 0) : surfaceMode

  const speaker = roster.find((p) => p.participantStatus === "joined" && p.userId !== currentUserId) ?? null
  const speakerName = speaker ? (users.find((u) => u.id === speaker.userId)?.name ?? null) : null

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const startHeight = drawerRef.current?.getBoundingClientRect().height ?? DRAWER_MIN_HEIGHT
    drag.current = {
      startY: e.clientY,
      startHeight,
      height: startHeight,
      velocity: 0,
      lastY: e.clientY,
      lastT: performance.now(),
    }
    e.currentTarget.setPointerCapture(e.pointerId)
    setDragHeight(startHeight)
    setDragging(true)
  }
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d) return
    const now = performance.now()
    const next = Math.min(Math.max(d.startHeight + (e.clientY - d.startY), DRAWER_MIN_HEIGHT), viewportHeight())
    const dt = now - d.lastT
    if (dt > 0) d.velocity = (e.clientY - d.lastY) / dt
    d.lastY = e.clientY
    d.lastT = now
    d.height = next
    setDragHeight(next)
  }
  const onPointerUp = () => {
    const d = drag.current
    drag.current = null
    setDragging(false)
    setDragHeight(null)
    if (d) setCallSurfaceMode(nearestMode(d.height, d.velocity))
  }

  const viewProps: ViewProps = { workspaceId, connectedAt, currentUserId, roster, speakerName, title }

  return (
    <div className="pointer-events-none fixed inset-x-0 top-0 z-50" style={{ paddingTop: "env(safe-area-inset-top)" }}>
      <div
        ref={drawerRef}
        data-testid="mobile-call-drawer"
        data-mode={contentMode}
        className={cn(
          "pointer-events-auto mx-auto flex flex-col overflow-hidden bg-background shadow-lg",
          FRAME_CLASS[contentMode],
          !dragging && !REDUCED_MOTION && "transition-[height] duration-200 ease-out"
        )}
        style={{ height: dragging && dragHeight != null ? `${dragHeight}px` : RESTING_HEIGHT[contentMode] }}
      >
        {contentMode !== "min" && captureError && <CaptureErrorBanner error={captureError} />}
        <div className="min-h-0 flex-1 overflow-hidden">
          {contentMode === "min" && <TabView connectedAt={connectedAt} captureError={captureError} />}
          {contentMode === "compact" && <BarView {...viewProps} />}
          {contentMode === "standard" && <TinyGalleryView {...viewProps} />}
          {contentMode === "full" && <FullscreenView {...viewProps} />}
        </div>
        {/* Keep the handle mounted while dragging even once the content crosses into
            `full`: it holds the pointer capture + the pointerup/cancel settle, so
            unmounting it mid-drag would strand `dragging` true and wedge the drawer. */}
        {(dragging || contentMode !== "full") && (
          <GrabHandle onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} />
        )}
      </div>
    </div>
  )
}
