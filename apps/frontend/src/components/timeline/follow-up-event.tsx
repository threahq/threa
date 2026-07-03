import { useState } from "react"
import { toast } from "sonner"
import { Clock, CalendarX2, Loader2 } from "lucide-react"
import type { AgentFollowUpScheduledEventPayload, AgentFollowUpCancelledEventPayload, StreamEvent } from "@threa/types"
import { agentFollowUpsApi } from "@/api"
import { useActors } from "@/hooks"
import { formatFullDateTime } from "@/lib/dates"

interface FollowUpEventProps {
  event: StreamEvent
  workspaceId: string
}

/**
 * Timeline row for `agent:follow_up_scheduled` (roadmap 1.3): the visible trace
 * of a persona scheduling a follow-up, so scheduled agent work is never
 * invisible state. Shows what it will do and when it fires, and — for any member
 * who can see the stream — a Cancel action (a button, not a link: it mutates,
 * INV-40). Cancelling flips the button to a muted "Cancelled" in place (INV-63:
 * the card state change is the confirmation, no success toast); other members
 * see the separate `agent:follow_up_cancelled` row. The fire time renders in the
 * viewer's local timezone (INV-42).
 */
export function FollowUpScheduledEvent({ event, workspaceId }: FollowUpEventProps) {
  const { getActorName } = useActors(workspaceId)
  const payload = event.payload as AgentFollowUpScheduledEventPayload | undefined
  const [cancelled, setCancelled] = useState(false)
  const [cancelling, setCancelling] = useState(false)

  if (!payload) return null

  const actorName = getActorName(event.actorId, event.actorType)
  const scheduledFor = new Date(payload.scheduledFor)

  async function handleCancel() {
    if (!payload) return
    setCancelling(true)
    try {
      const { cancelled: didCancel } = await agentFollowUpsApi.cancel(workspaceId, payload.followUpId)
      // A lost race (already fired/cancelled) still settles the button — the row
      // is no longer actionable either way.
      setCancelled(true)
      if (!didCancel) {
        toast.info("This follow-up already fired or was cancelled")
      }
    } catch {
      toast.error("Couldn't cancel the follow-up")
    } finally {
      setCancelling(false)
    }
  }

  return (
    <div className="py-2 px-3 sm:px-6 text-center">
      <p className="text-sm text-muted-foreground">
        <Clock className="inline-block h-3.5 w-3.5 mr-1.5 -mt-0.5 text-sky-500" aria-hidden="true" />
        {actorName} scheduled a follow-up for{" "}
        <span className="font-medium text-foreground/80">{formatFullDateTime(scheduledFor)}</span>
      </p>
      <p className="mt-0.5 text-sm text-foreground/70">{payload.note}</p>
      <div className="mt-1">
        {cancelled ? (
          <span className="text-xs text-muted-foreground">Cancelled</span>
        ) : (
          <button
            type="button"
            onClick={handleCancel}
            disabled={cancelling}
            className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground disabled:opacity-60"
          >
            {cancelling && <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />}
            Cancel
          </button>
        )}
      </div>
    </div>
  )
}

/**
 * Timeline row for `agent:follow_up_cancelled` (roadmap 1.3): renders standalone
 * so the cancellation stays visible even when the scheduling card has scrolled
 * out of the loaded window. Attribution (`actorId`/`actorType`) is whoever
 * cancelled — the persona, or a member via the card's Cancel button.
 */
export function FollowUpCancelledEvent({ event, workspaceId }: FollowUpEventProps) {
  const { getActorName } = useActors(workspaceId)
  const payload = event.payload as AgentFollowUpCancelledEventPayload | undefined

  if (!payload) return null

  const actorName = getActorName(event.actorId, event.actorType)

  return (
    <div className="py-2 px-3 sm:px-6 text-center">
      <p className="text-sm text-muted-foreground">
        <CalendarX2 className="inline-block h-3.5 w-3.5 mr-1.5 -mt-0.5" aria-hidden="true" />
        {actorName} cancelled a scheduled follow-up
      </p>
      <p className="mt-0.5 text-sm text-muted-foreground/70 line-through">{payload.note}</p>
    </div>
  )
}
