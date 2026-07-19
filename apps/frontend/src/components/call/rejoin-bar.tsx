import { useState } from "react"
import { Phone, Video } from "lucide-react"
import { api } from "@/api/client"
import { Button } from "@/components/ui/button"
import { useStreamBootstrap } from "@/hooks"
import { useCallLaunch } from "./call-launch-context"
import { useCallPhase } from "./call-store-hooks"

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
 * would leave a ghost tile for peers). Shown only on a cold load (local call
 * idle); once the viewer rejoins, `callPhase` flips off idle and the bar hides.
 */
export function RejoinBar({ workspaceId, streamId }: { workspaceId: string; streamId: string }) {
  const { data } = useStreamBootstrap(workspaceId, streamId)
  const { launch } = useCallLaunch()
  const callPhase = useCallPhase()
  const [dismissed, setDismissed] = useState(false)

  const activeCall = data?.activeCall
  if (!activeCall || !activeCall.selfLiveParticipant) return null
  // Only a cold load shows the bar: once the viewer is (re)joining/connected,
  // their live session already reflects the call.
  if (callPhase !== "idle") return null
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
          onClick={() => launch({ workspaceId, streamId, mode: activeCall.mode })}
        >
          Rejoin
        </Button>
      </div>
    </div>
  )
}
