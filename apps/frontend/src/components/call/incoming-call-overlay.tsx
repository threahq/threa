import { useCallback, useEffect, useRef } from "react"
import { useSearchParams } from "react-router-dom"
import { Phone, PhoneOff, BellOff, Video } from "lucide-react"
import { Button } from "@/components/ui/button"
import { api } from "@/api/client"
import { useIncomingCalls, settleIncomingCall, type IncomingCall } from "@/stores/incoming-call-store"
import { installRingAudioWarmup, startRing, stopRing } from "@/calls/ring-tone"
import { useCallLaunch } from "./call-launch-context"

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
 * Mute silences the audible ring without settling the ring. The shared ring
 * plays while any ring is live and the user isn't already in/joining a call;
 * INV-63 — no success toasts, the overlay is its own feedback.
 */
export function IncomingCallOverlay() {
  const calls = useIncomingCalls()
  const { launch, callActive } = useCallLaunch()
  const [searchParams, setSearchParams] = useSearchParams()
  const mutedRef = useRef(false)
  const notifiedRef = useRef<Set<string>>(new Set())

  useEffect(() => installRingAudioWarmup(), [])

  // Any live ring while not already in/joining a call → ring. A mute silences the
  // audible tone (kept in a ref so toggling it re-runs this effect). When the
  // page can't sound, fall back to a local SW notification, once per attempt.
  const hasRing = calls.length > 0
  useEffect(() => {
    if (!hasRing || callActive || mutedRef.current) {
      stopRing()
      return
    }
    const audible = startRing()
    if (!audible) {
      for (const call of calls) {
        if (!notifiedRef.current.has(call.attemptId)) {
          notifiedRef.current.add(call.attemptId)
          fireLocalRingNotification(call)
        }
      }
    }
    return () => stopRing()
  }, [hasRing, callActive, calls])

  // Drop notified-markers for attempts that have settled so a future reuse
  // (never, ids are unique) or memory growth can't accumulate.
  useEffect(() => {
    const live = new Set(calls.map((c) => c.attemptId))
    for (const id of notifiedRef.current) {
      if (!live.has(id)) notifiedRef.current.delete(id)
    }
    if (calls.length === 0) mutedRef.current = false
  }, [calls])

  const accept = useCallback(
    (call: IncomingCall) => {
      launch({ workspaceId: call.workspaceId, streamId: call.streamId, mode: call.mode })
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

  const muteRing = useCallback(() => {
    mutedRef.current = true
    stopRing()
  }, [])

  // Accept-intent from a ring notification click (`?call=<callId>`). Accept when
  // the ring is still live in-store; otherwise (cold open, push-only) just strip
  // the param and leave the user on the host stream — there's no live ring or
  // known media mode to safely auto-join from a bare id.
  const callParam = searchParams.get("call")
  useEffect(() => {
    if (!callParam) return
    const ring = calls.find((c) => c.callId === callParam)
    if (ring) accept(ring)
    const next = new URLSearchParams(searchParams)
    next.delete("call")
    setSearchParams(next, { replace: true })
  }, [callParam, calls, accept, searchParams, setSearchParams])

  if (calls.length === 0) return null

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col gap-2">
      {calls.map((call) => (
        <div
          key={call.attemptId}
          className="pointer-events-auto flex w-80 items-center gap-3 rounded-lg border bg-popover p-3 text-popover-foreground shadow-lg"
        >
          <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
            {call.mode === "video" ? <Video className="size-4" /> : <Phone className="size-4" />}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{call.inviterName ?? "Someone"} is calling…</p>
            <p className="text-xs text-muted-foreground">{call.mode === "video" ? "Video call" : "Voice call"}</p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button size="icon" variant="ghost" aria-label="Silence ring" onClick={muteRing}>
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
