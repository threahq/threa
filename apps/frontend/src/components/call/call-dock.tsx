import { useCallback, useEffect, type ReactNode } from "react"
import { SidePanel, SidePanelHeader, SidePanelTitle } from "@/components/ui/side-panel"
import { useIsMobile } from "@/hooks/use-mobile"
import { cn } from "@/lib/utils"
import { getCallState, setCallSurfaceMode, setDesktopSurfaceOverride } from "@/stores/call-store"
import { resolveDesktopSurface, setLastDesktopSurface, useCallPrefs } from "@/stores/call-prefs-store"
import { useCallLaunch } from "./call-launch-context"
import {
  useCallActiveElsewhere,
  useCallPhase,
  useCallStreamId,
  useCallWorkspaceId,
  useDesktopSurfaceOverride,
} from "./call-store-hooks"

// Bottom-anchored call surfaces clear the iOS home indicator on desktop (app
// convention — see message-composer.tsx) and, on a phone, sit a composer-height
// above the bottom (`--composer-height`, published on :root) so the dock never
// covers the floating composer. Shared with the incoming-call overlay so the two
// bottom-right surfaces line up (INV-35).
export const DOCK_BOTTOM =
  "bottom-[calc(var(--composer-height,5rem)_+_1rem)] sm:bottom-[max(1rem,env(safe-area-inset-bottom))]"

// The incoming-ring overlay lifted clear of the dock when both render (in a call
// + a second ring arrives): the dock's own bottom offset plus a fixed clearance
// so the ring card sits above the dock frame and never covers its controls (which
// live at the dock's bottom edge).
export const RING_ABOVE_DOCK_BOTTOM =
  "bottom-[calc(var(--composer-height,5rem)_+_5.5rem)] sm:bottom-[calc(max(1rem,env(safe-area-inset-bottom))_+_4.5rem)]"
import { MobileCallDrawer } from "./mobile-call-drawer"
import { MobileCallJoining } from "./call-island"
import { DesktopCallDock } from "./desktop-call-dock"
import { FloatingCallSquare } from "./floating-call-square"
import { PreJoinGate } from "./pre-join-gate"
import { ActiveElsewhereChip } from "./active-elsewhere-chip"

function DockFrame({ children }: { children: ReactNode }) {
  return (
    <div className={cn("fixed right-4 z-50 w-[340px] max-w-[calc(100vw-2rem)]", DOCK_BOTTOM)}>
      <SidePanel className="rounded-lg border shadow-xl sm:border">{children}</SidePanel>
    </div>
  )
}

function DockHeader({ title }: { title: string }) {
  return (
    <SidePanelHeader className="rounded-t-lg">
      <SidePanelTitle className="text-sm">{title}</SidePanelTitle>
    </SidePanelHeader>
  )
}

/**
 * The docked call surface. Mounts at the app-layout level and is driven purely by
 * the call-store phase — it deliberately survives in-app navigation and takes no
 * URL state. INV-59 exemption (plan §Call surface): a call is session-bound
 * hardware state no URL can restore; the URL-derived surface is the stream page
 * hosting the card, and the refresh story is the (later) rejoin bar — so deriving
 * the dock from `useState`/store rather than the URL is the sanctioned shape here.
 * Non-modal: a plain fixed panel on `side-panel` (never a Radix Dialog/sheet),
 * no autofocus, so it never traps focus or steals it from the composer.
 */
export function CallDock() {
  const phase = useCallPhase()
  const { state: launch } = useCallLaunch()
  const activeElsewhere = useCallActiveElsewhere()
  const storeStreamId = useCallStreamId()
  const workspaceId = useCallWorkspaceId()
  const isMobile = useIsMobile()
  const { desktopCallSurface, lastDesktopSurface } = useCallPrefs()
  const override = useDesktopSurfaceOverride()

  const launching = launch.status !== "idle"
  const inCall = phase === "connected" || phase === "reconnecting"
  const joining = phase === "joining"

  const surface = resolveDesktopSurface(desktopCallSurface, lastDesktopSurface, override)

  // An in-call switch moves THIS call (the override) and remembers the choice for
  // `keep_last` next time; the override clears on teardown, so a pinned surface wins
  // the next call (interaction model A). Silent — the surface change is its own signal.
  const dockToSide = useCallback(() => {
    setDesktopSurfaceOverride("sidebar")
    setLastDesktopSurface("sidebar")
  }, [])
  const float = useCallback(() => {
    setDesktopSurfaceOverride("floating")
    setLastDesktopSurface("floating")
  }, [])

  // On connect, open to a visible size — `min` (the Tab/Rail) is too minimal a
  // default. Open to the first open state (compact) normally, and the second
  // (standard/gallery) when joining with the camera on, so a video join lands on
  // tiles. Guarded on the initial `min` so it runs once and later drags win;
  // `surfaceMode` is read only by the sidebar dock (the square uses its own state).
  useEffect(() => {
    if (inCall && getCallState().surfaceMode === "min") {
      setCallSurfaceMode(getCallState().local.cameraOn ? "standard" : "compact")
    }
  }, [inCall])

  // Nothing to show: idle with no launch in flight. Surface the cross-tab chip if
  // another tab holds the call, otherwise render nothing.
  if (!launching && !inCall && !joining) {
    if (activeElsewhere) {
      return (
        <div className={cn("fixed right-4 z-50", DOCK_BOTTOM)}>
          <ActiveElsewhereChip />
        </div>
      )
    }
    return null
  }

  const streamIdForLabel = storeStreamId ?? (launch.status !== "idle" ? launch.request.streamId : null)

  // Mobile is unchanged: the 4-mode top drawer in-call, the same top island for
  // joining/permission (one surface, no bottom→top jump).
  if (isMobile) {
    if (inCall) return <MobileCallDrawer workspaceId={workspaceId} streamId={streamIdForLabel} />
    return <MobileCallJoining />
  }

  // Desktop floating: the square owns the whole lifecycle (launch / join / in-call).
  if (surface === "floating") {
    return <FloatingCallSquare workspaceId={workspaceId} streamId={streamIdForLabel} onDockToSide={dockToSide} />
  }

  // Desktop sidebar: the resizable dock in-call, the docked pre-join/joining panel
  // otherwise. The panel is not collapsible — it only ever shows the connecting/
  // permission gate, which must stay visible (mirrors the floating square).
  if (inCall) return <DesktopCallDock workspaceId={workspaceId} streamId={streamIdForLabel} onFloat={float} />
  return (
    <DockFrame>
      <DockHeader title="Call" />
      <div className="p-4">{joining && launch.status === "idle" ? <JoiningBody /> : <PreJoinGate />}</div>
    </DockFrame>
  )
}

function JoiningBody() {
  return <div className="flex items-center justify-center py-6 text-sm text-muted-foreground">Connecting…</div>
}
