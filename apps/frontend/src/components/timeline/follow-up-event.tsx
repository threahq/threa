import { useState } from "react"
import { toast } from "sonner"
import { Clock, Loader2 } from "lucide-react"
import type { AgentFollowUpScheduledEventPayload, StreamEvent } from "@threa/types"
import { agentFollowUpsApi } from "@/api"
import { useActors } from "@/hooks"
import { formatFullDateTime } from "@/lib/dates"
import { cn } from "@/lib/utils"

interface FollowUpScheduledEventProps {
  event: StreamEvent
  workspaceId: string
  /**
   * True when a matching `agent:follow_up_cancelled` event is in the loaded
   * window — the authoritative cancelled state, so every viewer (not just the
   * one who clicked) sees the card as cancelled, and it survives a reload.
   */
  cancelledByEvent?: boolean
}

/**
 * Timeline row for `agent:follow_up_scheduled` (roadmap 1.3): the visible trace
 * of a persona scheduling a follow-up, so scheduled agent work is never
 * invisible state. Shows what it will do and when it fires, and — for any member
 * who can see the stream — a Cancel action (a button, not a link: it mutates,
 * INV-40). The cancelled state is authoritative from `cancelledByEvent` (the
 * matching `agent:follow_up_cancelled` patch); the local optimistic flip only
 * fast-paths the clicking member's own feedback (INV-63: the card state change
 * is the confirmation, no success toast). A stale click on an already-fired
 * follow-up is a server-side no-op and must NOT mislabel the card, so it does
 * not flip locally. The fire time renders in the viewer's local timezone
 * (INV-42).
 */
export function FollowUpScheduledEvent({ event, workspaceId, cancelledByEvent = false }: FollowUpScheduledEventProps) {
  const { getActorName } = useActors(workspaceId)
  const payload = event.payload as AgentFollowUpScheduledEventPayload | undefined
  const [optimisticallyCancelled, setOptimisticallyCancelled] = useState(false)
  const [cancelling, setCancelling] = useState(false)

  if (!payload) return null

  const actorName = getActorName(event.actorId, event.actorType)
  const scheduledFor = new Date(payload.scheduledFor)
  const cancelled = cancelledByEvent || optimisticallyCancelled

  async function handleCancel() {
    // Re-entrancy guard replaces the native `disabled` attribute: a disabled
    // button loses focus (browsers blur it), which would drop a keyboard/AT
    // user mid-timeline during the request. `aria-disabled` keeps it focusable.
    if (!payload || cancelling || cancelled) return
    setCancelling(true)
    try {
      const { cancelled: didCancel } = await agentFollowUpsApi.cancel(workspaceId, payload.followUpId)
      if (didCancel) {
        // Fast-path the clicker's own feedback; other viewers flip when the
        // cancelled patch lands and sets `cancelledByEvent`.
        setOptimisticallyCancelled(true)
      } else {
        // Lost the race (already fired, or cancelled elsewhere). Don't flip to
        // "Cancelled" — that would durably mislabel a fired follow-up. The
        // authoritative `cancelledByEvent` covers a real cancel-by-another.
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
        {/*
         * One button throughout its lifecycle (Cancel → Cancelled): the label
         * swaps in place rather than unmounting, so a keyboard/AT user keeps
         * focus on it, and `aria-live` announces the terminal state. `aria-
         * disabled` (not `disabled`) makes it non-actionable while staying
         * focusable; `disabled` is reserved for the in-flight request.
         */}
        <button
          type="button"
          onClick={handleCancel}
          aria-disabled={cancelled || cancelling}
          aria-busy={cancelling}
          aria-live="polite"
          className={cn(
            "inline-flex items-center gap-1 text-xs font-medium text-muted-foreground",
            cancelled || cancelling ? "cursor-default" : "hover:text-foreground",
            cancelling && "opacity-60"
          )}
        >
          {cancelling && <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />}
          {cancelled ? "Cancelled" : "Cancel"}
        </button>
      </div>
    </div>
  )
}
