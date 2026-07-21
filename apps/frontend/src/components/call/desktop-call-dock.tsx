import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react"
import { AlertTriangle, ChevronDown, ChevronLeft, Minimize2, PanelBottom, PanelRight, Pin, Users } from "lucide-react"
import { getAvatarUrl } from "@threa/types"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { cn } from "@/lib/utils"
import { getInitials } from "@/lib/initials"
import { useStreamName } from "@/hooks/use-stream-name"
import { useInputMode } from "@/hooks/use-input-mode"
import { useWorkspaceUserId } from "@/hooks/use-workspaces"
import { useWorkspaceUsers } from "@/stores/workspace-store"
import {
  setCallSurfaceMode,
  type CallCaptureErrorInfo,
  type CallRosterParticipant,
  type CallSurfaceMode,
} from "@/stores/call-store"
import { useCallPrefs, setCallFilmstripSide, setCallSideDockWidth } from "@/stores/call-prefs-store"
import { CallTile } from "./call-tile"
import { CallControls } from "./call-controls"
import { CameraButton, LeaveButton, MuteButton } from "./call-control-buttons"
import { CallStageLayout } from "./call-stage-layout"
import { CallTimer } from "./call-timer"
import { CaptureErrorBanner } from "./call-capture-error"
import { LayoutToggle } from "./layout-toggle"
import { useCallCaptureError, useCallConnectedAt, useCallRoster, useCallSurfaceMode } from "./call-store-hooks"

const REDUCED_MOTION =
  typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches

const RAIL_WIDTH = 56
const MIN_OPEN = 280
// Always leave this much of the conversation beside a pushing dock, so a narrow
// window / wide sidebar can't collapse the timeline to nothing.
const MIN_CONTENT = 320
const FULLSCREEN_FRACTION = 0.75

/**
 * The resting open clamp: ≤75% of the content region, leaving MIN_CONTENT of timeline
 * where the window allows. On a sub-~600px content region the outer floor wins (MIN_OPEN),
 * so a very narrow window trades some timeline rather than shrinking the dock below usable.
 */
function maxOpenWidth(ceil: number): number {
  return Math.max(MIN_OPEN, Math.min(FULLSCREEN_FRACTION * ceil, ceil - MIN_CONTENT))
}

function clampOpen(width: number, ceil: number): number {
  return Math.min(Math.max(width, MIN_OPEN), maxOpenWidth(ceil))
}

/** First-open width before the user has ever resized: video opens fuller than audio (#1486). */
function defaultOpen(mode: CallSurfaceMode): number {
  return mode === "compact" ? 360 : 520
}

interface DockViewProps {
  workspaceId: string | null
  connectedAt: number | null
  currentUserId: string | null
  roster: CallRosterParticipant[]
  users: ReturnType<typeof useWorkspaceUsers>
  captureError: CallCaptureErrorInfo | null
  title: string
  // Rendered from the minimized hover-overlay (a transient peek) rather than a
  // pinned-open dock — shows the pin affordance to commit the peek.
  peeking?: boolean
}

function FilmstripSideToggle() {
  const { filmstripSide } = useCallPrefs()
  return (
    <ToggleGroup
      type="single"
      size="sm"
      role="radiogroup"
      value={filmstripSide}
      onValueChange={(next) => {
        if (next === "bottom" || next === "side") setCallFilmstripSide(next)
      }}
      aria-label="Filmstrip position"
      data-testid="call-filmstrip-side-toggle"
      className="shrink-0 gap-0.5 rounded-md bg-white/10 p-0.5"
    >
      <ToggleGroupItem
        value="bottom"
        aria-label="Filmstrip bottom"
        title="Filmstrip along the bottom"
        className="h-7 px-2 [&_svg]:size-3.5"
      >
        <PanelBottom aria-hidden="true" />
      </ToggleGroupItem>
      <ToggleGroupItem
        value="side"
        aria-label="Filmstrip side"
        title="Filmstrip down the side"
        className="h-7 px-2 [&_svg]:size-3.5"
      >
        <PanelRight aria-hidden="true" />
      </ToggleGroupItem>
    </ToggleGroup>
  )
}

function MinimizeButton() {
  return (
    <button
      type="button"
      aria-label="Minimize call"
      onClick={() => setCallSurfaceMode("min")}
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
    >
      <Minimize2 className="h-4 w-4" />
    </button>
  )
}

/** Keeps a hover-peek open (mouse pre-empts the rail's expand chevron, so the peek needs its own pin). */
function PinButton() {
  return (
    <button
      type="button"
      aria-label="Keep call open"
      onClick={() => setCallSurfaceMode("standard")}
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
    >
      <Pin className="h-4 w-4" />
    </button>
  )
}

/**
 * Title + trailing action. A hover-peek shows Pin (commit to open); an already-open
 * dock shows Minimize (collapse) — a peek is dismissed by moving the mouse away, so
 * Minimize there would be a redundant no-op.
 */
function DockHeaderBar({ title, peeking }: { title: string; peeking?: boolean }) {
  return (
    <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
      <span className="min-w-0 flex-1 truncate text-sm font-medium">{title}</span>
      {peeking ? <PinButton /> : <MinimizeButton />}
    </div>
  )
}

function RailAvatars({ roster, users, workspaceId }: Pick<DockViewProps, "roster" | "users" | "workspaceId">) {
  const joined = roster.filter((p) => p.participantStatus === "joined").slice(0, 4)
  return (
    <div className="flex flex-col items-center gap-1.5 overflow-hidden">
      {joined.map((p) => {
        const u = users.find((x) => x.id === p.userId)
        const url = u?.avatarUrl && workspaceId ? getAvatarUrl(workspaceId, u.avatarUrl, 64) : undefined
        return (
          <Avatar key={p.userId} className="h-8 w-8">
            {url && <AvatarImage src={url} alt={u?.name ?? "participant"} />}
            <AvatarFallback className="text-xs">{getInitials(u?.name ?? "?")}</AvatarFallback>
          </Avatar>
        )
      })}
    </div>
  )
}

/** Side `min`: a 56px icon strip — restore chevron, live/error dot, avatars, timer. */
function SideRailView({ roster, users, workspaceId, connectedAt, captureError }: DockViewProps) {
  return (
    <div className="flex h-full w-full flex-col items-center gap-2 border-l bg-background py-3">
      <button
        type="button"
        aria-label="Expand call"
        onClick={() => setCallSurfaceMode("compact")}
        className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <ChevronLeft className="h-4 w-4" />
      </button>
      {captureError ? (
        <span
          className="flex h-5 w-5 items-center justify-center text-destructive"
          role="alert"
          data-testid="call-capture-error"
          aria-label="Microphone or camera problem — expand the call to see details"
        >
          <AlertTriangle className="h-4 w-4" aria-hidden />
        </span>
      ) : (
        <span
          className={cn("h-2 w-2 shrink-0 rounded-full bg-primary", !REDUCED_MOTION && "animate-pulse")}
          aria-hidden
        />
      )}
      <RailAvatars roster={roster} users={users} workspaceId={workspaceId} />
      <div className="mt-auto flex flex-col items-center gap-1">
        <MuteButton />
        <CameraButton />
        <LeaveButton />
      </div>
      <CallTimer connectedAt={connectedAt} className="text-xs" />
    </div>
  )
}

/** Side `compact`/`standard`: header + tile grid + controls (the panel width does the sizing). */
function SideTilesView({ workspaceId, currentUserId, roster, captureError, title, peeking }: DockViewProps) {
  const joined = roster.filter((p) => p.participantStatus === "joined")
  return (
    <div className="flex h-full w-full flex-col border-l bg-background">
      <DockHeaderBar title={title} peeking={peeking} />
      {captureError && <CaptureErrorBanner error={captureError} className="mx-3 mt-2" />}
      <div className={cn("grid flex-1 gap-2 overflow-y-auto p-3", joined.length > 1 ? "grid-cols-2" : "grid-cols-1")}>
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
    </div>
  )
}

/** Fullscreen: the ch5 stage with a permanent header of call controls/toggles. */
function DockFullscreenView({ workspaceId, connectedAt, currentUserId, roster, title, captureError }: DockViewProps) {
  const { layout, filmstripSide } = useCallPrefs()
  const joined = roster.filter((p) => p.participantStatus === "joined")
  // View-only pin (not the store): overrides the default speaker until the call ends.
  const [pinnedUserId, setPinnedUserId] = useState<string | null>(null)

  return (
    <div className="flex h-full w-full flex-col bg-call-stage text-white">
      {captureError && <CaptureErrorBanner error={captureError} className="mx-3 mt-2" />}
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          aria-label="Collapse call"
          onClick={() => setCallSurfaceMode("standard")}
          className="flex h-9 w-9 items-center justify-center rounded-md text-white/80 hover:bg-white/10 hover:text-white"
        >
          <ChevronDown className="h-5 w-5" />
        </button>
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-medium">{title}</span>
          <CallTimer connectedAt={connectedAt} className="text-white/70" />
        </div>
        <span className="ml-2 flex shrink-0 items-center gap-1 text-xs text-white/70" aria-label="Participants in call">
          <Users className="h-3.5 w-3.5" aria-hidden />
          {joined.length}
        </span>
        <div className="ml-auto flex items-center gap-2">
          {layout === "speaker" && <FilmstripSideToggle />}
          <div data-testid="call-layout-slot">
            <LayoutToggle className="bg-white/10" />
          </div>
        </div>
      </div>

      <CallStageLayout
        layout={layout}
        filmstripSide={filmstripSide}
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

function DockBody({ mode, view }: { mode: CallSurfaceMode; view: DockViewProps }) {
  if (mode === "full") return <DockFullscreenView {...view} />
  if (mode === "min") return <SideRailView {...view} />
  return <SideTilesView {...view} />
}

function DockResizeHandle({
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
      aria-orientation="vertical"
      aria-label="Resize call"
      data-testid="call-dock-handle"
      className="absolute inset-y-0 left-0 z-10 flex w-2 cursor-col-resize touch-none items-center justify-center"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <span className="h-10 w-1 rounded-full bg-muted-foreground/40" aria-hidden />
    </div>
  )
}

interface DragState {
  start: number
  startSize: number
  size: number
  full: number
}

/**
 * The desktop in-call surface: a resizable dock, docked to the side, with a
 * freeform open width (persisted as {@link CallPrefs.sideDockWidth}) capped at
 * {@link FULLSCREEN_FRACTION} of the content region; dragging past that cap goes
 * Fullscreen. It pushes the conversation aside via `--call-dock-inset-right` (the
 * main content region reserves the inset) rather than overlaying it, until
 * Fullscreen. Rendered by {@link import("./call-dock").CallDock} on desktop for
 * the connected phase; reads the call store, not the route, so it survives
 * stream navigation.
 */
export function DesktopCallDock({ workspaceId, streamId }: { workspaceId: string | null; streamId: string | null }) {
  const surfaceMode = useCallSurfaceMode()
  const { sideDockWidth } = useCallPrefs()
  const inputMode = useInputMode()
  const roster = useCallRoster()
  const connectedAt = useCallConnectedAt()
  const captureError = useCallCaptureError()
  const currentUserId = useWorkspaceUserId(workspaceId ?? "")
  const users = useWorkspaceUsers(workspaceId ?? undefined)
  const name = useStreamName(workspaceId ?? "", streamId ?? "", "generic")
  const title = name ?? "Call"

  const rootRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const drag = useRef<DragState | null>(null)
  const [dragging, setDragging] = useState(false)
  const [dragSize, setDragSize] = useState<number | null>(null)
  const [hovering, setHovering] = useState(false)
  // The dock root spans the content region (left = sidebar width → right:0); its
  // measured width is the ceiling for the panel + inset so a narrow window / wide
  // sidebar can never push the panel over the sidebar or squash the timeline to 0.
  const [contentW, setContentW] = useState<number>(Infinity)
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const measure = () => setContentW(el.clientWidth)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Ceiling from the measured content region; 0 means "not laid out yet" (initial
  // render / jsdom) → treat as unbounded so we never clamp to nothing.
  const ceilW = contentW || Infinity

  // The resting open width: the saved freeform width (or the mode's first-open
  // default), clamped to ≤75% and always leaving MIN_CONTENT.
  const openWidth = clampOpen(sideDockWidth ?? defaultOpen(surfaceMode), ceilW)

  // Content push: rail → RAIL_WIDTH, open → openWidth (already ≤ ceil−MIN_CONTENT),
  // fullscreen → 0. Hovering the rail is an overlay, so the inset tracks surfaceMode
  // (still `min`) and never reflows the timeline.
  let insetRight: number
  if (surfaceMode === "full") insetRight = 0
  else if (surfaceMode === "min") insetRight = RAIL_WIDTH
  else insetRight = openWidth
  useEffect(() => {
    document.documentElement.style.setProperty("--call-dock-inset-right", `${insetRight}px`)
  }, [insetRight])
  useEffect(
    () => () => {
      document.documentElement.style.setProperty("--call-dock-inset-right", "0px")
    },
    []
  )

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const panel = panelRef.current?.getBoundingClientRect()
    const root = rootRef.current?.getBoundingClientRect()
    const full = root?.width ?? ceilW
    const startSize = panel?.width ?? openWidth
    drag.current = { start: e.clientX, startSize, size: startSize, full }
    e.currentTarget.setPointerCapture(e.pointerId)
    setDragSize(startSize)
    setDragging(true)
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d) return
    // Side grows as the pointer moves left; allow dragging up into the fullscreen zone.
    const grow = d.start - e.clientX
    const next = Math.min(Math.max(d.startSize + grow, MIN_OPEN), d.full)
    d.size = next
    setDragSize(next)
  }

  const onPointerUp = () => {
    const d = drag.current
    drag.current = null
    setDragging(false)
    setDragSize(null)
    if (!d) return
    if (d.size > FULLSCREEN_FRACTION * d.full) {
      setCallSurfaceMode("full")
      return
    }
    setCallSideDockWidth(clampOpen(d.size, d.full))
    // Dragging out of the rail (or out of fullscreen) opens it; an already-open mode keeps its mode.
    if (surfaceMode === "min" || surfaceMode === "full") setCallSurfaceMode("standard")
  }

  // While dragging, don't MOUNT the fullscreen stage (its heavy per-frame re-render
  // thrashes the drag) — the preview stays on the open tiles; fullscreen mounts on release.
  // Minimized + mouse hover = a transient peek (overlay, no push); it renders the open
  // tiles and shows a pin affordance to commit to a pushing, persisted open dock.
  const peeking = surfaceMode === "min" && hovering
  let cappedDragMode: CallSurfaceMode | null = null
  if (dragging) cappedDragMode = surfaceMode === "compact" ? "compact" : "standard"
  let contentMode: CallSurfaceMode
  if (cappedDragMode) contentMode = cappedDragMode
  else if (peeking) contentMode = "standard"
  else contentMode = surfaceMode

  const dragCeil = drag.current?.full ?? ceilW
  // No cue while already fullscreen (a drag there is an EXIT — the cue would misread as "go full").
  const showFullscreenCue =
    dragging && surfaceMode !== "full" && dragSize != null && dragSize > FULLSCREEN_FRACTION * dragCeil

  let panelWidth: number
  if (dragging && dragSize != null) panelWidth = dragSize
  else if (surfaceMode === "min") panelWidth = hovering ? openWidth : RAIL_WIDTH
  else panelWidth = openWidth

  const restingFull = !dragging && surfaceMode === "full"
  let positionClass: string
  let sizeStyle: CSSProperties
  if (restingFull) {
    positionClass = "inset-0"
    sizeStyle = {}
  } else {
    positionClass = "inset-y-0 right-0"
    sizeStyle = { width: `${panelWidth}px` }
  }

  const view: DockViewProps = {
    workspaceId,
    connectedAt,
    currentUserId,
    roster,
    users,
    captureError,
    title,
    peeking,
  }

  return (
    <div
      ref={rootRef}
      className="pointer-events-none fixed inset-y-0 right-0 z-40"
      style={{ left: "var(--app-content-left, 0px)" }}
    >
      <div
        ref={panelRef}
        data-testid="desktop-call-dock"
        data-mode={contentMode}
        data-position="side"
        data-hovering={hovering ? "true" : "false"}
        onMouseEnter={() => {
          // Preview only arms from the rail (mirrors the nav-sidebar collapsed→preview);
          // entering an open panel — including while minimizing with the cursor over it —
          // must not flip to the overlay.
          if (inputMode !== "touch" && surfaceMode === "min") setHovering(true)
        }}
        onMouseLeave={() => setHovering(false)}
        className={cn(
          "pointer-events-auto absolute overflow-hidden shadow-xl",
          positionClass,
          !dragging && !REDUCED_MOTION && "transition-[width] duration-200 ease-out"
        )}
        style={sizeStyle}
      >
        <DockBody mode={contentMode} view={view} />
        {showFullscreenCue && (
          <div
            data-testid="call-dock-fullscreen-cue"
            className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center border-2 border-dashed border-primary bg-primary/10"
          >
            <span className="rounded-md bg-background/80 px-3 py-1.5 text-sm font-medium">
              Release to go fullscreen
            </span>
          </div>
        )}
        {/* Always mounted — including at rest-fullscreen — so it holds the pointer
            capture/settle through a drag into full AND lets you drag back OUT of
            fullscreen (a thin edge strip over the stage); collapse via chevron still works. */}
        <DockResizeHandle onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} />
      </div>
    </div>
  )
}
