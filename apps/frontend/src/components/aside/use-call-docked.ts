import { getCallState } from "@/stores/call-store"
import { getCallPrefs, resolveDesktopSurface, useCallPrefs } from "@/stores/call-prefs-store"
import { useCallPhase, useDesktopSurfaceOverride } from "@/components/call/call-store-hooks"
import { isMobileViewport, useIsMobile } from "@/hooks/use-mobile"

/** Whether the desktop call dock currently owns the right edge (`CallDock` → `DesktopCallDock`). */
export function isCallDocked(): boolean {
  const call = getCallState()
  if (call.phase === "idle" || isMobileViewport()) return false
  const prefs = getCallPrefs()
  return (
    resolveDesktopSurface(prefs.desktopCallSurface, prefs.lastDesktopSurface, call.desktopSurfaceOverride) === "sidebar"
  )
}

export function useCallDocked(): boolean {
  const phase = useCallPhase()
  const override = useDesktopSurfaceOverride()
  const { desktopCallSurface, lastDesktopSurface } = useCallPrefs()
  const isMobile = useIsMobile()
  if (phase === "idle" || isMobile) return false
  return resolveDesktopSurface(desktopCallSurface, lastDesktopSurface, override) === "sidebar"
}
