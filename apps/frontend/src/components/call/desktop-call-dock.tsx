import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react"
import { AlertTriangle, ChevronDown, ChevronLeft, Minimize2, PanelBottom, PanelRight, Users } from "lucide-react"
import { getAvatarUrl } from "@threa/types"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { cn } from "@/lib/utils"
import { getInitials } from "@/lib/initials"
import { useStreamName } from "@/hooks/use-stream-name"
import { useWorkspaceUserId } from "@/hooks/use-workspaces"
import { useWorkspaceUsers } from "@/stores/workspace-store"
import {
  setCallSurfaceMode,
  type CallCaptureErrorInfo,
  type CallRosterParticipant,
  type CallSurfaceMode,
} from "@/stores/call-store"
import { useCallPrefs, setCallFilmstripSide } from "@/stores/call-prefs-store"
import { CallTile } from "./call-tile"
import { CallControls } from "./call-controls"
import { CallStageLayout } from "./call-stage-layout"
import { CallTimer } from "./call-timer"
import { CaptureErrorBanner } from "./call-capture-error"
import { LayoutToggle } from "./layout-toggle"
import { useCallCaptureError, useCallConnectedAt, useCallRoster, useCallSurfaceMode } from "./call-store-hooks"
import { nearestStep } from "./mobile-call-drawer-snap"

const REDUCED_MOTION =
  typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches

const MODES: readonly CallSurfaceMode[] = ["min", "compact", "standard", "full"]
const MODE_INDEX: Record<CallSurfaceMode, number> = { min: 0, compact: 1, standard: 2, full: 3 }

/** The 3 pushing step sizes (px) — min/compact/standard; `full` = the whole content region. */
const SIDE_STEP_SIZES: readonly number[] = [56, 320, 520]

// Always leave this much of the conversation beside/below a pushing dock, so a
// narrow window / wide sidebar can't collapse the timeline to nothing.
const MIN_CONTENT = 320

/**
 * The 4 snap detents [min, compact, standard, full] for a given axis ceiling (the
 * measured content region). The pushing steps are capped to `ceil - MIN_CONTENT`
 * (leaving timeline) and `full` is the whole ceiling — guaranteeing a NON-DECREASING
 * list even on a tiny window (so the snap never sees an unsorted/duplicate-final
 * detent), and the inset a pushing mode reserves never exceeds `ceil - MIN_CONTENT`.
 */
function dockDetents(steps: readonly number[], ceil: number): number[] {
  const cap = Math.max(steps[0], ceil - MIN_CONTENT)
  return [steps[0], Math.min(steps[1], cap), Math.min(steps[2], cap), ceil]
}

interface DockViewProps {
  workspaceId: string | null
  connectedAt: number | null
  currentUserId: string | null
  roster: CallRosterParticipant[]
  users: ReturnType<typeof useWorkspaceUsers>
  captureError: CallCaptureErrorInfo | null
  title: string
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

/** Title + minimize, shared by the side Panel/Wide. */
function DockHeaderBar({ title }: { title: string }) {
  return (
    <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
      <span className="min-w-0 flex-1 truncate text-sm font-medium">{title}</span>
      <MinimizeButton />
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
      <div className="mt-auto">
        <CallTimer connectedAt={connectedAt} className="text-xs" />
      </div>
    </div>
  )
}

/** Side `compact`/`standard`: header + tile grid + controls (the panel width does the sizing). */
function SideTilesView({ workspaceId, currentUserId, roster, captureError, title }: DockViewProps) {
  const joined = roster.filter((p) => p.participantStatus === "joined")
  return (
    <div className="flex h-full w-full flex-col border-l bg-background">
      <DockHeaderBar title={title} />
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
  velocity: number
  last: number
  lastT: number
  full: number
}

/**
 * The desktop in-call surface: a resizable dock, docked to the side, snapping
 * through the four {@link CallSurfaceMode} steps with the same physics as the
 * mobile drawer ({@link nearestStep}). It pushes the conversation aside via
 * `--call-dock-inset-right` (the main content region reserves the inset) rather
 * than overlaying it, until Fullscreen. Rendered by
 * {@link import("./call-dock").CallDock} on desktop for the connected phase;
 * reads the call store, not the route, so it survives stream navigation.
 */
export function DesktopCallDock({ workspaceId, streamId }: { workspaceId: string | null; streamId: string | null }) {
  const surfaceMode = useCallSurfaceMode()
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
  const detentsW = dockDetents(SIDE_STEP_SIZES, ceilW)

  // Content push: reserve the pushing mode's detent (which already leaves MIN_CONTENT)
  // on :root so the main content region (AppShell's <main>) reflows. Fullscreen → 0.
  const insetRight = surfaceMode !== "full" ? detentsW[MODE_INDEX[surfaceMode]] : 0
  useEffect(() => {
    document.documentElement.style.setProperty("--call-dock-inset-right", `${insetRight}px`)
  }, [insetRight])
  useEffect(
    () => () => {
      document.documentElement.style.setProperty("--call-dock-inset-right", "0px")
    },
    []
  )

  const minStep = SIDE_STEP_SIZES[0]

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const panel = panelRef.current?.getBoundingClientRect()
    const root = rootRef.current?.getBoundingClientRect()
    const full = root?.width ?? SIDE_STEP_SIZES[SIDE_STEP_SIZES.length - 1]
    const startSize = panel?.width ?? SIDE_STEP_SIZES[1]
    const pointer = e.clientX
    drag.current = {
      start: pointer,
      startSize,
      size: startSize,
      velocity: 0,
      last: pointer,
      lastT: performance.now(),
      full,
    }
    e.currentTarget.setPointerCapture(e.pointerId)
    setDragSize(startSize)
    setDragging(true)
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d) return
    const pointer = e.clientX
    // Side grows as the pointer moves left.
    const grow = d.start - pointer
    const next = Math.min(Math.max(d.startSize + grow, minStep), d.full)
    const now = performance.now()
    const dt = now - d.lastT
    const stepGrow = d.last - pointer
    if (dt > 0) d.velocity = stepGrow / dt
    d.last = pointer
    d.lastT = now
    d.size = next
    setDragSize(next)
  }

  const onPointerUp = () => {
    const d = drag.current
    drag.current = null
    setDragging(false)
    setDragSize(null)
    if (d) {
      // A pause before release means the drag stopped — don't flick on stale velocity.
      const vel = performance.now() - d.lastT > 120 ? 0 : d.velocity
      setCallSurfaceMode(MODES[nearestStep(d.size, vel, dockDetents(SIDE_STEP_SIZES, d.full))])
    }
  }

  const dragFull = drag.current?.full ?? SIDE_STEP_SIZES[SIDE_STEP_SIZES.length - 1]
  const dragMode =
    dragging && dragSize != null ? MODES[nearestStep(dragSize, 0, dockDetents(SIDE_STEP_SIZES, dragFull))] : null
  // While dragging, don't MOUNT the fullscreen stage (its heavy per-frame re-render
  // thrashes the drag) — the preview caps at `standard`; fullscreen mounts on release.
  const cappedDragMode = dragMode === "full" ? "standard" : dragMode
  const contentMode: CallSurfaceMode = cappedDragMode ?? surfaceMode

  const restingFull = !dragging && surfaceMode === "full"
  let positionClass: string
  let sizeStyle: CSSProperties
  if (restingFull) {
    positionClass = "inset-0"
    sizeStyle = {}
  } else {
    positionClass = "inset-y-0 right-0"
    const w = dragging && dragSize != null ? dragSize : detentsW[MODE_INDEX[contentMode]]
    sizeStyle = { width: `${w}px` }
  }

  const view: DockViewProps = {
    workspaceId,
    connectedAt,
    currentUserId,
    roster,
    users,
    captureError,
    title,
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
        className={cn(
          "pointer-events-auto absolute overflow-hidden shadow-xl",
          positionClass,
          !dragging && !REDUCED_MOTION && "transition-[width] duration-200 ease-out"
        )}
        style={sizeStyle}
      >
        <DockBody mode={contentMode} view={view} />
        {/* Always mounted — including at rest-fullscreen — so it holds the pointer
            capture/settle through a drag into full AND lets you drag back OUT of
            fullscreen (a thin edge strip over the stage); collapse via chevron still works. */}
        <DockResizeHandle onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} />
      </div>
    </div>
  )
}
