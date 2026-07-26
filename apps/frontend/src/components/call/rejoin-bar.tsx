import { useState } from "react"
import { Phone, Video } from "lucide-react"
import { api } from "@/api/client"
import { Button } from "@/components/ui/button"
import { useStreamBootstrap } from "@/hooks"
import { useActiveCall } from "@/stores/active-calls-store"
import { useCallLaunch } from "./call-launch-context"
import { useCallPhase, useCallStreamId } from "./call-store-hooks"

/**
 * The reload-while-in-call story (roadmap 1.4, INV-59). A docked call is
 * session-bound hardware state no URL can restore, so a fresh page load drops
 * the media incarnation — but the server still holds the viewer's `joined`
 * participant row under its lease. `StreamBootstrap.activeCall.selfLiveParticipant`
 * surfaces exactly that, and this prominent bar offers a fresh rejoin.
 *
 * Rejoin mints a new incarnation via the launch flow (start-or-join on the same
 * stream, gesture-safe). "Leave" is a real leave, not a dismiss: it closes the
 * viewer's live endpoints server-side so the lease can't keep them a zombie
 * participant for the ~45s grace window (the alternative — a silent dismiss —
 * would leave a ghost tile for peers).
 *
 * Liveness rides the active-calls store (the SAME source the CallCard reads), not
 * the bootstrap alone: `StreamBootstrap.activeCall` is a `staleTime:Infinity`
 * snapshot that never refetches, so if the call ends mid-session only the store
 * learns it. The bar needs BOTH — `selfLiveParticipant` (the "it was ME under a
 * lease" fact only the bootstrap has) AND the store still confirming the call is
 * live — or a dead Rejoin/Leave lingers after the call is over.
 */
export function RejoinBar({ workspaceId, streamId }: { workspaceId: string; streamId: string }) {
  const { data } = useStreamBootstrap(workspaceId, streamId)
  const activeCall = data?.activeCall
  const live = useActiveCall(workspaceId, activeCall?.callId)
  const { launch } = useCallLaunch()
  const callPhase = useCallPhase()
  const inCallStreamId = useCallStreamId()
  const [dismissed, setDismissed] = useState(false)

  // Both signals must hold: the viewer was a live participant (bootstrap) AND the
  // store still tracks the call as live. When the store drops it, the bar hides.
  if (!activeCall || !activeCall.selfLiveParticipant || !live) return null
  // Hide only when the viewer's live local session is on THIS stream (already
  // (re)joining/connected here). A call on a DIFFERENT stream must NOT suppress the
  // bar — that's the un-reaped zombie lease it exists to clear. Mirrors the
  // CallCard's stream-scoped `selfInThisCall`.
  if (callPhase !== "idle" && inCallStreamId === streamId) return null
  if (dismissed) return null

  const ModeIcon = activeCall.mode === "audio_only" ? Phone : Video

  function handleLeave() {
    setDismissed(true)
    // Fire-and-forget: closing the server-side endpoints retracts the ghost tile;
    // a failure just falls back to the lease reaping it within the grace window.
    void api.post(`/api/workspaces/${workspaceId}/calls/${activeCall!.callId}/leave`, {}).catch(() => {})
  }

  return (
    <div className="flex items-center gap-3 border-b border-primary/30 bg-primary/10 px-4 py-2">
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/20 text-primary">
        <ModeIcon className="h-3.5 w-3.5" aria-hidden="true" />
      </span>
      <p className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground/90">
        You&rsquo;re still in this call
      </p>
      <div className="flex shrink-0 items-center gap-2">
        <Button size="sm" variant="ghost" className="h-7 px-2 text-[12px]" onClick={handleLeave}>
          Leave
        </Button>
        <Button
          size="sm"
          className="h-7 px-3 text-[12px]"
          onClick={() =>
            launch({
              workspaceId,
              streamId,
              mode: activeCall.mode,
              expectedCallId: activeCall.callId,
              // The bar only shows while the viewer holds a live endpoint they are
              // not on — a lapsed lease from this tab's previous incarnation (a
              // rebind server-side) or a genuinely live other device. Asking for
              // takeover covers both; it is a no-op when the rebind path applies.
              takeover: true,
            })
          }
        >
          Rejoin
        </Button>
      </div>
    </div>
  )
}
