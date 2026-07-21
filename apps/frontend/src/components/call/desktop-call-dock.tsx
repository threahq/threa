import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react"
import {
  AlertTriangle,
  ChevronDown,
  ChevronLeft,
  Minimize2,
  PanelBottom,
  PanelRight,
  PanelTop,
  Users,
} from "lucide-react"
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
import {
  useCallPrefs,
  setCallDockPosition,
  setCallFilmstripSide,
  type CallDockPosition,
} from "@/stores/call-prefs-store"
import { CallTile } from "./call-tile"
import { CallControls } from "./call-controls"
import { CallStageLayout } from "./call-stage-layout"
import { CameraButton, LeaveButton, MuteButton } from "./call-control-buttons"
import { CallTimer } from "./call-timer"
import { CaptureErrorBanner } from "./call-capture-error"
import { LayoutToggle } from "./layout-toggle"
import { useCallCaptureError, useCallConnectedAt, useCallRoster, useCallSurfaceMode } from "./call-store-hooks"
import { nearestStep } from "./mobile-call-drawer-snap"

const REDUCED_MOTION =
  typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches

const MODES: readonly CallSurfaceMode[] = ["min", "compact", "standard", "full"]

/** Resting sizes (px) of the min/compact/standard steps; `full` is the content dimension, measured per drag. */
const SIDE_STEP_SIZES: readonly number[] = [56, 320, 520]
const TOP_STEP_SIZES: readonly number[] = [44, 72, 220]

// Resting size (px) per mode for the dock panel AND the content-push inset it
// reserves. `full` overlays (inset 0). Both are clamped to the measured content
// region at render so a narrow window / wide sidebar can't push the panel over the
// sidebar or collapse the timeline to nothing (the content region is the ceiling).
const SIDE_RESTING: Record<CallSurfaceMode, number> = { min: 56, compact: 320, standard: 520, full: 0 }
const TOP_RESTING: Record<CallSurfaceMode, number> = { min: 44, compact: 72, standard: 220, full: 0 }
const SIDE_INSET: Record<CallSurfaceMode, number> = { min: 56, compact: 320, standard: 520, full: 0 }
const TOP_INSET: Record<CallSurfaceMode, number> = { min: 44, compact: 72, standard: 220, full: 0 }

interface DockViewProps {
  workspaceId: string | null
  connectedAt: number | null
  currentUserId: string | null
  roster: CallRosterParticipant[]
  users: ReturnType<typeof useWorkspaceUsers>
  captureError: CallCaptureErrorInfo | null
  title: string
  speakerName: string | null
}

function DockPositionToggle({ dark = false }: { dark?: boolean }) {
  const { dockPosition } = useCallPrefs()
  return (
    <ToggleGroup
      type="single"
      size="sm"
      role="radiogroup"
      value={dockPosition}
      onValueChange={(next) => {
        if (next === "top" || next === "side") setCallDockPosition(next)
      }}
      aria-label="Dock position"
      data-testid="call-dock-position-toggle"
      className={cn("shrink-0 gap-0.5 rounded-md p-0.5", dark ? "bg-white/10" : "bg-muted")}
    >
      <ToggleGroupItem value="top" aria-label="Top" title="Dock to the top" className="h-7 px-2 [&_svg]:size-3.5">
        <PanelTop aria-hidden="true" />
      </ToggleGroupItem>
      <ToggleGroupItem value="side" aria-label="Side" title="Dock to the side" className="h-7 px-2 [&_svg]:size-3.5">
        <PanelRight aria-hidden="true" />
      </ToggleGroupItem>
    </ToggleGroup>
  )
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

/** Title + Top/Side toggle + minimize, shared by the side Panel/Wide and the top Gallery. */
function DockHeaderBar({ title }: { title: string }) {
  return (
    <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
      <span className="min-w-0 flex-1 truncate text-sm font-medium">{title}</span>
      <DockPositionToggle />
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

/** Top `min`: a thin bar — live/error dot + timer, tap to expand. */
function TopTabView({ connectedAt, captureError }: DockViewProps) {
  return (
    <button
      type="button"
      aria-label="Expand call"
      onClick={() => setCallSurfaceMode("compact")}
      className="flex h-full w-full items-center justify-center gap-2 border-b bg-background px-4"
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

/** Top `compact`: timer + speaker + controls, horizontal. */
function TopBarView({ connectedAt, speakerName, captureError }: DockViewProps) {
  return (
    <div className="flex h-full w-full items-center gap-3 border-b bg-background px-4">
      {captureError && (
        <span
          className="flex h-8 w-8 shrink-0 items-center justify-center text-destructive"
          role="alert"
          data-testid="call-capture-error"
          aria-label="Microphone or camera problem"
        >
          <AlertTriangle className="h-4 w-4" aria-hidden />
        </span>
      )}
      <div className="flex min-w-0 flex-col">
        <CallTimer connectedAt={connectedAt} />
        {speakerName && <span className="truncate text-xs text-muted-foreground">{speakerName}</span>}
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        <MuteButton />
        <CameraButton />
        <LeaveButton />
        <DockPositionToggle />
        <MinimizeButton />
      </div>
    </div>
  )
}

/** Top `standard`: header + a tiles row + controls. */
function TopGalleryView({ workspaceId, currentUserId, roster, captureError, title }: DockViewProps) {
  const joined = roster.filter((p) => p.participantStatus === "joined")
  return (
    <div className="flex h-full w-full flex-col border-b bg-background">
      <DockHeaderBar title={title} />
      {captureError && <CaptureErrorBanner error={captureError} className="mx-3 mt-2" />}
      <div className="flex min-h-0 flex-1 items-stretch gap-2 overflow-x-auto px-3 py-2">
        {joined.map((p) => (
          <div key={p.userId} className="aspect-video h-full shrink-0">
            <CallTile
              participant={p}
              workspaceId={workspaceId}
              isSelf={!!currentUserId && p.userId === currentUserId}
              stage
              fill
            />
          </div>
        ))}
      </div>
      <div className="shrink-0 border-t p-2">
        <CallControls />
      </div>
    </div>
  )
}

/** Fullscreen (both orientations): the ch5 stage with a permanent header of call controls/toggles. */
function DockFullscreenView({ workspaceId, connectedAt, currentUserId, roster, title }: DockViewProps) {
  const { layout, filmstripSide } = useCallPrefs()
  const joined = roster.filter((p) => p.participantStatus === "joined")
  // View-only pin (not the store): overrides the default speaker until the call ends.
  const [pinnedUserId, setPinnedUserId] = useState<string | null>(null)

  return (
    <div className="flex h-full w-full flex-col bg-call-stage text-white">
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
          <DockPositionToggle dark />
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

function DockBody({
  dockPosition,
  mode,
  view,
}: {
  dockPosition: CallDockPosition
  mode: CallSurfaceMode
  view: DockViewProps
}) {
  if (mode === "full") return <DockFullscreenView {...view} />
  if (dockPosition === "side") {
    if (mode === "min") return <SideRailView {...view} />
    return <SideTilesView {...view} />
  }
  if (mode === "min") return <TopTabView {...view} />
  if (mode === "compact") return <TopBarView {...view} />
  return <TopGalleryView {...view} />
}

function DockResizeHandle({
  orientation,
  onPointerDown,
  onPointerMove,
  onPointerUp,
}: {
  orientation: CallDockPosition
  onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void
  onPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => void
  onPointerUp: (e: ReactPointerEvent<HTMLDivElement>) => void
}) {
  const side = orientation === "side"
  return (
    <div
      role="separator"
      aria-orientation={side ? "vertical" : "horizontal"}
      aria-label="Resize call"
      data-testid="call-dock-handle"
      className={cn(
        "absolute z-10 flex touch-none items-center justify-center",
        side ? "inset-y-0 left-0 w-2 cursor-col-resize" : "inset-x-0 bottom-0 h-2 cursor-row-resize"
      )}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <span className={cn("rounded-full bg-muted-foreground/40", side ? "h-10 w-1" : "h-1 w-10")} aria-hidden />
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
 * The desktop in-call surface: a resizable dock, docked to the top or the side
 * (`dockPosition` pref), snapping through the four {@link CallSurfaceMode} steps
 * with the same physics as the mobile drawer ({@link nearestStep}). It pushes the
 * conversation aside via `--call-dock-inset-right`/`--call-dock-inset-top` (the
 * main content region reserves the inset) rather than overlaying it, until
 * Fullscreen. Rendered by {@link import("./call-dock").CallDock} on desktop for
 * the connected phase; reads the call store, not the route, so it survives stream
 * navigation.
 */
export function DesktopCallDock({ workspaceId, streamId }: { workspaceId: string | null; streamId: string | null }) {
  const { dockPosition } = useCallPrefs()
  const surfaceMode = useCallSurfaceMode()
  const roster = useCallRoster()
  const connectedAt = useCallConnectedAt()
  const captureError = useCallCaptureError()
  const currentUserId = useWorkspaceUserId(workspaceId ?? "")
  const users = useWorkspaceUsers(workspaceId ?? undefined)
  const name = useStreamName(workspaceId ?? "", streamId ?? "", "generic")
  const title = name ?? "Call"

  const isSide = dockPosition === "side"

  const rootRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const drag = useRef<DragState | null>(null)
  const [dragging, setDragging] = useState(false)
  const [dragSize, setDragSize] = useState<number | null>(null)
  // The dock root spans the content region (left = sidebar width → right:0); its
  // measured size is the ceiling for the panel + inset so a narrow window / wide
  // sidebar can never push the panel over the sidebar or squash the timeline to 0.
  const [content, setContent] = useState<{ w: number; h: number }>({ w: Infinity, h: Infinity })
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const measure = () => setContent({ w: el.clientWidth, h: el.clientHeight })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Ceilings from the measured content region; 0 means "not laid out yet" (initial
  // render / jsdom) → treat as unbounded so we never clamp to nothing.
  const ceilW = content.w || Infinity
  const ceilH = content.h || Infinity

  // Content push: reserve the resting size (clamped to the content region) on :root
  // so the main content region (AppShell's <main>) reflows. Fullscreen overlays → 0.
  const insetRight = isSide ? Math.min(SIDE_INSET[surfaceMode], ceilW) : 0
  const insetTop = isSide ? 0 : Math.min(TOP_INSET[surfaceMode], ceilH)
  useEffect(() => {
    const root = document.documentElement
    root.style.setProperty("--call-dock-inset-right", `${insetRight}px`)
    root.style.setProperty("--call-dock-inset-top", `${insetTop}px`)
  }, [insetRight, insetTop])
  useEffect(
    () => () => {
      const root = document.documentElement
      root.style.setProperty("--call-dock-inset-right", "0px")
      root.style.setProperty("--call-dock-inset-top", "0px")
    },
    []
  )

  const stepSizes = isSide ? SIDE_STEP_SIZES : TOP_STEP_SIZES
  const minStep = stepSizes[0]

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const panel = panelRef.current?.getBoundingClientRect()
    const root = rootRef.current?.getBoundingClientRect()
    const full = (isSide ? root?.width : root?.height) ?? stepSizes[stepSizes.length - 1]
    const startSize = (isSide ? panel?.width : panel?.height) ?? stepSizes[1]
    const pointer = isSide ? e.clientX : e.clientY
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
    const pointer = isSide ? e.clientX : e.clientY
    // Side grows as the pointer moves left; top grows as it moves down.
    const grow = isSide ? d.start - pointer : pointer - d.start
    const next = Math.min(Math.max(d.startSize + grow, minStep), d.full)
    const now = performance.now()
    const dt = now - d.lastT
    const stepGrow = isSide ? d.last - pointer : pointer - d.last
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
    if (d) setCallSurfaceMode(MODES[nearestStep(d.size, d.velocity, [...stepSizes, d.full])])
  }

  const speaker = roster.find((p) => p.participantStatus === "joined" && p.userId !== currentUserId) ?? null
  const speakerName = speaker ? (users.find((u) => u.id === speaker.userId)?.name ?? null) : null

  const dragFull = drag.current?.full ?? stepSizes[stepSizes.length - 1]
  const contentMode: CallSurfaceMode =
    dragging && dragSize != null ? MODES[nearestStep(dragSize, 0, [...stepSizes, dragFull])] : surfaceMode

  const restingFull = !dragging && contentMode === "full"
  let positionClass: string
  let sizeStyle: CSSProperties
  if (restingFull) {
    positionClass = "inset-0"
    sizeStyle = {}
  } else if (isSide) {
    positionClass = "inset-y-0 right-0"
    const w = dragging && dragSize != null ? dragSize : Math.min(SIDE_RESTING[contentMode], ceilW)
    sizeStyle = { width: `${w}px` }
  } else {
    positionClass = "inset-x-0 top-0"
    const h = dragging && dragSize != null ? dragSize : Math.min(TOP_RESTING[contentMode], ceilH)
    sizeStyle = { height: `${h}px` }
  }

  const view: DockViewProps = {
    workspaceId,
    connectedAt,
    currentUserId,
    roster,
    users,
    captureError,
    title,
    speakerName,
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
        data-position={dockPosition}
        className={cn(
          "pointer-events-auto absolute overflow-hidden shadow-xl",
          positionClass,
          !dragging && !REDUCED_MOTION && (isSide ? "transition-[width]" : "transition-[height]"),
          !dragging && !REDUCED_MOTION && "duration-200 ease-out"
        )}
        style={sizeStyle}
      >
        <DockBody dockPosition={dockPosition} mode={contentMode} view={view} />
        {/* Keep the handle mounted while dragging even after the content crosses into
            `full`: it holds the pointer capture + the pointerup/cancel settle, so
            unmounting it mid-drag would strand `dragging` true and wedge the dock. */}
        {(dragging || contentMode !== "full") && (
          <DockResizeHandle
            orientation={dockPosition}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
          />
        )}
      </div>
    </div>
  )
}
