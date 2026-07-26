import { useCallback, useLayoutEffect, useRef } from "react"
import { useIsMobile } from "@/hooks/use-mobile"
import { cn } from "@/lib/utils"
import { getCallState, setCallSurfaceMode, setDesktopSurfaceOverride } from "@/stores/call-store"
import {
  resolveDesktopSurface,
  setLastDesktopSurface,
  useCallPrefs,
  type DesktopSurface,
} from "@/stores/call-prefs-store"
import { useCallLaunch } from "./call-launch-context"
import {
  useCallActiveElsewhere,
  useCallPhase,
  useCallStreamId,
  useCallWorkspaceId,
  useDesktopSurfaceOverride,
  useDisplacedCall,
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
import { DesktopCallFullscreen } from "./desktop-call-fullscreen"
import { ActiveElsewhereChip } from "./active-elsewhere-chip"
import { CallMovedChip } from "./call-moved-chip"

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
  const displaced = useDisplacedCall()
  const storeStreamId = useCallStreamId()
  const workspaceId = useCallWorkspaceId()
  const isMobile = useIsMobile()
  const { desktopCallSurface, lastDesktopSurface } = useCallPrefs()
  const override = useDesktopSurfaceOverride()

  const launching = launch.status !== "idle"
  const inCall = phase === "connected" || phase === "reconnecting"
  const joining = phase === "joining"
  const joiningModeRef = useRef<"compact" | "standard">("compact")
  if (launch.status !== "idle") joiningModeRef.current = launch.request.cameraOn ? "standard" : "compact"

  const surface = resolveDesktopSurface(desktopCallSurface, lastDesktopSurface, override)
  const surfacePickerTriggerRef = useRef<HTMLButtonElement>(null)
  const focusSurfacePicker = useRef(false)

  const setSurface = useCallback((next: DesktopSurface) => {
    setDesktopSurfaceOverride(next)
    setLastDesktopSurface(next)
  }, [])
  const selectSurface = useCallback(
    (next: DesktopSurface) => {
      if (next === surface) return
      focusSurfacePicker.current = true
      if (next === "sidebar" && getCallState().surfaceMode === "min") setCallSurfaceMode("standard")
      setSurface(next)
    },
    [setSurface, surface]
  )
  useLayoutEffect(() => {
    if (!focusSurfacePicker.current) return
    focusSurfacePicker.current = false
    surfacePickerTriggerRef.current?.focus()
  }, [surface])

  // On connect, open to a visible size — `min` (the Tab/Rail) is too minimal a
  // default. Open to the first open state (compact) normally, and the second
  // (standard/gallery) when joining with the camera on, so a video join lands on
  // tiles. Guarded on the initial `min` so it runs once and later drags win;
  // `surfaceMode` is read only by the sidebar dock (the square uses its own state).
  useLayoutEffect(() => {
    if (inCall && getCallState().surfaceMode === "min") {
      setCallSurfaceMode(getCallState().local.cameraOn ? "standard" : "compact")
    }
  }, [inCall])

  // Nothing to show: idle with no launch in flight. Surface the displaced-call
  // chip if another device took this call over, then the cross-tab chip if another
  // tab holds it, otherwise render nothing.
  if (!launching && !inCall && !joining) {
    joiningModeRef.current = "compact"
    if (displaced) {
      return (
        <div className={cn("fixed right-4 z-50", DOCK_BOTTOM)}>
          <CallMovedChip />
        </div>
      )
    }
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

  if (surface === "floating") {
    return (
      <FloatingCallSquare
        workspaceId={workspaceId}
        streamId={streamIdForLabel}
        onSelectSurface={selectSurface}
        surfacePickerTriggerRef={surfacePickerTriggerRef}
      />
    )
  }

  if (surface === "fullscreen") {
    return (
      <DesktopCallFullscreen
        workspaceId={workspaceId}
        streamId={streamIdForLabel}
        joining={!inCall}
        onSelectSurface={selectSurface}
        surfacePickerTriggerRef={surfacePickerTriggerRef}
      />
    )
  }

  // Desktop sidebar owns launch, joining, and connected phases. Keeping one
  // full-height dock mounted avoids swapping a detached loader for the real dock
  // after the call connects; the joining gate renders inside its content region.
  // Cancel clears launch state before the manager's async rollback leaves the
  // joining phase; retain the request-derived width until this surface unmounts.
  return (
    <DesktopCallDock
      workspaceId={workspaceId}
      streamId={streamIdForLabel}
      onSelectSurface={selectSurface}
      onDragToFullscreen={() => setSurface("fullscreen")}
      surfacePickerTriggerRef={surfacePickerTriggerRef}
      joining={!inCall}
      joiningMode={joiningModeRef.current}
    />
  )
}
