import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { useMatch, useSearchParams } from "react-router-dom"
import { toast } from "sonner"
import { Phone, PhoneOff, BellOff, Video } from "lucide-react"
import { PrefNotificationLevels, resolveNotificationPause } from "@threahq/types"
import { Button } from "@/components/ui/button"
import { api } from "@/api/client"
import { cn } from "@/lib/utils"
import { useCurrentWorkspaceUser } from "@/hooks/use-workspaces"
import { useIsMobile } from "@/hooks/use-mobile"
import { useCallSurfaceMode, useDesktopSurfaceOverride } from "./call-store-hooks"
import { useWorkspaceUserPreferences } from "@/stores/workspace-store"
import { useIncomingCalls, settleIncomingCall, type IncomingCall } from "@/stores/incoming-call-store"
import { installRingAudioWarmup, startRing, stopRing } from "@/calls/ring-tone"
import { useCallLaunch } from "./call-launch-context"
import { DOCK_BOTTOM, RING_ABOVE_DOCK_BOTTOM } from "./call-dock"
import { placementOverlapsProtected, resolveAvoidanceOffset, type Point } from "./call-surface-geometry"
import { useFloatingSurfaceGeometry } from "@/stores/floating-surface-geometry-store"
import { resolveDesktopSurface, useCallPrefs } from "@/stores/call-prefs-store"

interface RingPlacement {
  offset: Point
  /** No placement clears the surface's controls, so the ring must yield stacking. */
  yieldStacking: boolean
}

const NO_PLACEMENT: RingPlacement = { offset: { x: 0, y: 0 }, yieldStacking: false }

/**
 * Keep the CSS-anchored ring stack clear of the draggable floating call surface.
 * The stack is measured where the browser laid it out and the applied translation
 * subtracted back out, so the input to {@link resolveAvoidanceOffset} is always the
 * un-translated anchor rect — the policy therefore converges in one extra render
 * and never drifts as the square is dragged.
 *
 * Placement is applied instantly, with no transition or hysteresis: an animated
 * or damped move would spend its duration on top of the controls it exists to
 * clear, which is the exact failure this avoids.
 */
function useRingPlacement(containerRef: { current: HTMLElement | null }): RingPlacement {
  const obstacle = useFloatingSurfaceGeometry()
  const appliedRef = useRef<RingPlacement>(NO_PLACEMENT)
  const [placement, setPlacement] = useState<RingPlacement>(NO_PLACEMENT)

  const measure = useCallback(() => {
    const el = containerRef.current
    if (!el) return
    const applied = appliedRef.current
    const box = el.getBoundingClientRect()
    const anchored = {
      x: box.left - applied.offset.x,
      y: box.top - applied.offset.y,
      width: box.width,
      height: box.height,
    }
    const raw = resolveAvoidanceOffset(anchored, obstacle, {
      width: window.innerWidth,
      height: window.innerHeight,
    })
    // Round before comparing: measured rects are subpixel, so an unrounded offset
    // can differ from the applied one by a fraction that the rendered transform
    // rounds away — the comparison never settles and the effect re-renders forever.
    const offset = { x: Math.round(raw.x), y: Math.round(raw.y) }
    const yieldStacking = placementOverlapsProtected(anchored, offset, obstacle)
    // Compare both: a drag can leave the offset identical while flipping whether
    // that placement is still clear, and only re-rendering restores the stacking.
    if (offset.x === applied.offset.x && offset.y === applied.offset.y && yieldStacking === applied.yieldStacking) {
      return
    }
    const next = { offset, yieldStacking }
    appliedRef.current = next
    setPlacement(next)
  }, [containerRef, obstacle])

  useLayoutEffect(measure)

  useEffect(() => {
    window.addEventListener("resize", measure)
    return () => window.removeEventListener("resize", measure)
  }, [measure])

  return placement
}

/**
 * Fire a local service-worker notification for a ring when the page can't sound
 * (no gesture yet → suspended AudioContext), so the OS still alerts. Tagged
 * `call-<attemptId>` — the same tag the backend ring push uses — so a socket
 * fallback and a push never stack two notifications for one attempt; a
 * `call_ring_cancel` push or the settle-close path removes it.
 */
function fireLocalRingNotification(call: IncomingCall): void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return
  void navigator.serviceWorker.ready
    .then((registration) =>
      registration.showNotification(call.inviterName ? `${call.inviterName} is calling…` : "Incoming call…", {
        body: call.mode === "video" ? "Video call" : "Voice call",
        icon: "/threa-logo-192.png",
        badge: "/threa-logo-192.png",
        tag: `call-${call.attemptId}`,
        data: { kind: "call_ring", callId: call.callId, workspaceId: call.workspaceId, streamId: call.streamId },
      } as NotificationOptions)
    )
    .catch(() => {})
}

/**
 * The incoming-call ring surface. Non-modal and deliberately non-focus-stealing
 * (the plan is explicit): fixed to a corner, no autofocus, no Enter/Escape
 * binding — an arriving ring never hijacks the keyboard from whatever the user
 * is doing. Accept joins the call immediately (the pre-join gate only appears if
 * devices fail, via CallLaunch); Decline hits the invitee-scoped REST endpoint;
 * Mute silences the audible ring for that one attempt without settling it. The
 * shared ring plays while any un-muted ring is live and the user isn't already
 * in/joining a call — unless the user has notifications off or is on
 * do-not-disturb, in which case the visual card still shows but stays silent.
 * INV-63 — no success toasts, the overlay is its own feedback.
 */
export function IncomingCallOverlay({ workspaceId }: { workspaceId: string }) {
  const calls = useIncomingCalls()
  const { launch, callActive } = useCallLaunch()
  const surfaceMode = useCallSurfaceMode()
  const desktopSurfaceOverride = useDesktopSurfaceOverride()
  const { desktopCallSurface, lastDesktopSurface } = useCallPrefs()
  const desktopSurface = resolveDesktopSurface(desktopCallSurface, lastDesktopSurface, desktopSurfaceOverride)
  const isMobile = useIsMobile()
  const [searchParams, setSearchParams] = useSearchParams()
  const notifiedRef = useRef<Set<string>>(new Set())
  const containerRef = useRef<HTMLDivElement>(null)
  const { offset: avoidanceOffset, yieldStacking } = useRingPlacement(containerRef)
  // Per-attempt mute (INV-... scoped so a fresh ring rings again). State, not a
  // ref, so muting one ring re-evaluates whether any other ring should still sound.
  const [mutedAttempts, setMutedAttempts] = useState<Set<string>>(() => new Set())

  // Audible ring respects the invitee's notification prefs like the push does:
  // level NONE or an active do-not-disturb pause suppresses the sound (the card
  // stays visible — the ring is still actionable, just silent).
  const prefs = useWorkspaceUserPreferences(workspaceId)
  const currentUser = useCurrentWorkspaceUser(workspaceId)
  const notificationsSuppressed =
    prefs?.notificationLevel === PrefNotificationLevels.NONE ||
    (currentUser ? resolveNotificationPause(currentUser, new Date()) !== null : false)

  useEffect(() => installRingAudioWarmup(), [])

  // Any un-muted live ring while not already in/joining a call and not suppressed
  // → ring. When the page can't sound, fall back to a local SW notification, once
  // per attempt.
  const hasAudibleRing = calls.some((c) => !mutedAttempts.has(c.attemptId))
  useEffect(() => {
    if (!hasAudibleRing || callActive || notificationsSuppressed) {
      stopRing()
      return
    }
    const audible = startRing()
    if (!audible) {
      for (const call of calls) {
        if (mutedAttempts.has(call.attemptId) || notifiedRef.current.has(call.attemptId)) continue
        notifiedRef.current.add(call.attemptId)
        fireLocalRingNotification(call)
      }
    }
    return () => stopRing()
  }, [hasAudibleRing, callActive, notificationsSuppressed, calls, mutedAttempts])

  // Drop markers for attempts that have settled so memory can't accumulate and a
  // (never-happening) id reuse would ring again.
  useEffect(() => {
    const live = new Set(calls.map((c) => c.attemptId))
    for (const id of notifiedRef.current) {
      if (!live.has(id)) notifiedRef.current.delete(id)
    }
    setMutedAttempts((prev) => {
      let changed = false
      const next = new Set<string>()
      for (const id of prev) {
        if (live.has(id)) next.add(id)
        else changed = true
      }
      return changed ? next : prev
    })
  }, [calls])

  const accept = useCallback(
    (call: IncomingCall) => {
      launch({
        workspaceId: call.workspaceId,
        streamId: call.streamId,
        mode: call.mode,
        // Bind the join to this invitation's call: if the stream's live call has
        // since changed, the server 409s CALL_ENDED instead of dumping the user
        // into an unrelated call.
        expectedCallId: call.callId,
      })
      settleIncomingCall(call.attemptId)
    },
    [launch]
  )

  const decline = useCallback((call: IncomingCall) => {
    // Clear locally first (the ring is over for this user); the REST decline
    // drives the settle broadcast to the caller and this user's other devices.
    settleIncomingCall(call.attemptId)
    void api.post(`/api/workspaces/${call.workspaceId}/calls/invitations/${call.attemptId}/decline`, {}).catch(() => {})
  }, [])

  const muteRing = useCallback((attemptId: string) => {
    setMutedAttempts((prev) => {
      if (prev.has(attemptId)) return prev
      const next = new Set(prev)
      next.add(attemptId)
      return next
    })
  }, [])

  // Accept-intent from a ring notification click (`?call=<callId>`). A cold PWA
  // open runs this before the socket delivers the ring (rings are socket-only,
  // no bootstrap fetch), so an empty store is NOT evidence the call ended —
  // join through the server instead: the start guard 409s CALL_ENDED (handled
  // by CallLaunchProvider as "This call has ended") rather than starting a new
  // call, and a live one is simply joined. The in-store ring still short-circuits
  // to accept() so the local overlay settles immediately.
  const callParam = searchParams.get("call")
  const streamMatch = useMatch("/w/:workspaceId/s/:streamId")
  const streamIdFromUrl = streamMatch?.params.streamId ?? null
  useEffect(() => {
    if (!callParam) return
    const ring = calls.find((c) => c.callId === callParam)
    if (ring) accept(ring)
    else if (streamIdFromUrl) {
      // The notification URL always targets the call's host stream. Mode is
      // server-owned on join; audio_only just means no camera auto-on.
      launch({ workspaceId, streamId: streamIdFromUrl, mode: "audio_only", expectedCallId: callParam })
    } else toast.info("Couldn't open this call")
    const next = new URLSearchParams(searchParams)
    next.delete("call")
    setSearchParams(next, { replace: true })
  }, [callParam, calls, accept, launch, workspaceId, streamIdFromUrl, searchParams, setSearchParams])

  if (calls.length === 0) return null

  // Horizontal: clear a desktop SIDE dock via its inset var (0 with no side dock /
  // in fullscreen / on mobile, so the ring stays at the edge otherwise). Vertical:
  // lift above the bottom only when a call surface covers it — mobile or desktop
  // fullscreen (both put their control bar at the bottom). Non-fullscreen docks leave
  // the bottom free (mobile drawer is at the top; a side dock is cleared horizontally).
  const liftAboveDock = callActive && (isMobile ? surfaceMode === "full" : desktopSurface === "fullscreen")

  return (
    <div
      ref={containerRef}
      data-testid="incoming-call-overlay"
      className={cn(
        "pointer-events-none fixed flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2",
        // Normally the ring shares the floating surface's level and simply moves
        // out of its way. When the viewport is too crowded for any clear
        // placement, geometry can't help — so the ring drops one level and the
        // z-50 call surface paints above it and keeps its pointer input. Losing a
        // corner of a ring card beats losing Leave.
        yieldStacking ? "z-[49]" : "z-50",
        liftAboveDock ? RING_ABOVE_DOCK_BOTTOM : DOCK_BOTTOM
      )}
      style={{
        right: "calc(1rem + var(--call-dock-inset-right, 0px))",
        transform:
          avoidanceOffset.x || avoidanceOffset.y
            ? `translate(${avoidanceOffset.x}px, ${avoidanceOffset.y}px)`
            : undefined,
      }}
    >
      {calls.map((call) => (
        <div
          key={call.attemptId}
          role="alert"
          className="pointer-events-auto flex items-center gap-3 rounded-lg border bg-popover p-3 text-popover-foreground shadow-lg"
        >
          <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
            {call.mode === "video" ? <Video className="size-4" /> : <Phone className="size-4" />}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{call.inviterName ?? "Someone"} is calling…</p>
            <p className="text-xs text-muted-foreground">{call.mode === "video" ? "Video call" : "Voice call"}</p>
          </div>
          <div className="flex shrink-0 items-center gap-1" inert={yieldStacking}>
            <Button size="icon" variant="ghost" aria-label="Silence ring" onClick={() => muteRing(call.attemptId)}>
              <BellOff className="size-4" />
            </Button>
            <Button size="icon" variant="destructive" aria-label="Decline call" onClick={() => decline(call)}>
              <PhoneOff className="size-4" />
            </Button>
            <Button size="icon" aria-label="Accept call" onClick={() => accept(call)}>
              <Phone className="size-4" />
            </Button>
          </div>
        </div>
      ))}
    </div>
  )
}
