import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react"
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
import { useCallPrefs } from "@/stores/call-prefs-store"
import { CallTile } from "./call-tile"
import { CallStageLayout } from "./call-stage-layout"
import { CallControls } from "./call-controls"
import { CameraButton, FlipButton, LeaveButton, MuteButton } from "./call-control-buttons"
import { ISLAND_SURFACE } from "./call-island"
import { CallTimer } from "./call-timer"
import { CaptureErrorBanner } from "./call-capture-error"
import { LayoutToggle } from "./layout-toggle"
import { useCallCaptureError, useCallConnectedAt, useCallRoster, useCallSurfaceMode } from "./call-store-hooks"
import { DRAWER_MIN_HEIGHT, nearestMode } from "./mobile-call-drawer-snap"

const REDUCED_MOTION =
  typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches

/**
 * Per-mode frame classes. `min`/`compact` are floating dark "island" capsules
 * (pairing with the Dynamic Island); `standard`/`full` are full-width panels on
 * the app background. bg/shadow live here (not the base) so each mode owns its
 * surface.
 */
const FRAME_CLASS: Record<CallSurfaceMode, string> = {
  min: cn("mt-1.5 w-fit rounded-full", ISLAND_SURFACE),
  compact: cn("mt-1.5 w-fit rounded-[26px]", ISLAND_SURFACE),
  standard: "w-full border-b bg-background text-foreground shadow-lg",
  full: "w-full bg-background text-foreground",
}

/**
 * Resting CSS height per mode. `min` is the intrinsic pill; `compact` is fixed so
 * the drag detents stay stable (see mobile-call-drawer-snap); `full` fills below
 * the status bar.
 */
const RESTING_HEIGHT: Record<CallSurfaceMode, string> = {
  min: "auto",
  compact: "72px",
  standard: "248px",
  full: "calc(100dvh - env(safe-area-inset-top))",
}

function viewportHeight(): number {
  if (typeof window === "undefined") return DRAWER_MIN_HEIGHT
  return window.visualViewport?.height ?? window.innerHeight
}

function GrabHandle({
  onDark,
  onPointerDown,
  onPointerMove,
  onPointerUp,
}: {
  onDark: boolean
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
      className="flex shrink-0 touch-none cursor-grab items-center justify-center py-1.5 active:cursor-grabbing"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <span className={cn("h-1 w-10 rounded-full", onDark ? "bg-white/40" : "bg-muted-foreground/40")} aria-hidden />
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

function BarView({ connectedAt }: ViewProps) {
  // Ghost buttons live on the dark island: they inherit the island's white text,
  // so this overrides only the (light) ghost hover — NOT the base color, which
  // would clobber MuteButton's `text-destructive` muted tint. Leave keeps its red.
  const darkBtn = "hover:bg-white/10 hover:text-white"
  return (
    <div className="flex items-center gap-1 px-2">
      <span
        className={cn("ml-2 mr-0.5 h-2 w-2 shrink-0 rounded-full bg-primary", !REDUCED_MOTION && "animate-pulse")}
        aria-hidden
      />
      <CallTimer connectedAt={connectedAt} className="mr-1 text-white" />
      <MuteButton className={darkBtn} />
      <CameraButton className={darkBtn} />
      <FlipButton className={darkBtn} />
      <LeaveButton />
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

function FullscreenView({ workspaceId, connectedAt, currentUserId, roster, title }: ViewProps) {
  const { layout } = useCallPrefs()
  // View-only pin (not the store): overrides the default speaker until the call ends.
  const [pinnedUserId, setPinnedUserId] = useState<string | null>(null)

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
        <div data-testid="call-layout-slot" className="ml-auto">
          <LayoutToggle className="bg-white/10" />
        </div>
      </div>

      <CallStageLayout
        layout={layout}
        filmstripSide="bottom"
        participants={roster}
        currentUserId={currentUserId}
        workspaceId={workspaceId}
        pinnedUserId={pinnedUserId}
        onPin={setPinnedUserId}
      />

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
    if (d) {
      // A pause before release means the drag stopped — don't flick on stale velocity.
      const vel = performance.now() - d.lastT > 120 ? 0 : d.velocity
      setCallSurfaceMode(nearestMode(d.height, vel))
    }
  }

  const viewProps: ViewProps = { workspaceId, connectedAt, currentUserId, roster, speakerName, title }

  return (
    <div className="pointer-events-none fixed inset-x-0 top-0 z-50" style={{ paddingTop: "env(safe-area-inset-top)" }}>
      <div
        ref={drawerRef}
        data-testid="mobile-call-drawer"
        data-mode={contentMode}
        className={cn(
          "pointer-events-auto mx-auto flex flex-col overflow-hidden",
          FRAME_CLASS[contentMode],
          !dragging && !REDUCED_MOTION && "transition-[height] duration-200 ease-out"
        )}
        style={{ height: dragging && dragHeight != null ? `${dragHeight}px` : RESTING_HEIGHT[contentMode] }}
      >
        {contentMode !== "min" && captureError && <CaptureErrorBanner error={captureError} className="mx-3 mt-2" />}
        <div className="min-h-0 flex-1 overflow-hidden">
          {contentMode === "min" && <TabView connectedAt={connectedAt} captureError={captureError} />}
          {contentMode === "compact" && <BarView {...viewProps} />}
          {contentMode === "standard" && <TinyGalleryView {...viewProps} />}
          {contentMode === "full" && <FullscreenView {...viewProps} />}
        </div>
        {/* The handle is the drag affordance AND the "this pill is interactive /
            expandable" cue on the collapsed island; shown on every mode but `full`.
            Kept mounted while dragging even once content crosses into `full`: it
            holds the pointer capture + the pointerup/cancel settle, so unmounting it
            mid-drag would strand `dragging` true and wedge the drawer. */}
        {(dragging || contentMode !== "full") && (
          <GrabHandle
            onDark={contentMode === "min" || contentMode === "compact"}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
          />
        )}
      </div>
    </div>
  )
}
