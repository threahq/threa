import { useState, type ReactNode } from "react"
import { toast } from "sonner"
import { Clock, Check, Loader2 } from "lucide-react"
import type { AgentFollowUpScheduledEventPayload, StreamEvent } from "@threa/types"
import { agentFollowUpsApi } from "@/api"
import { useActors } from "@/hooks"
import { formatFireTime, formatFullDateTime } from "@/lib/dates"
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
 * Timeline row for `agent:follow_up_scheduled` (roadmap 1.3): a compact card in
 * the agent-session-event vocabulary (icon tile · content · right-slot action),
 * so scheduled agent work reads as one glanceable object rather than a wall of
 * centered text. The note is the headline; the persona + fire time is the meta.
 * The golden-thread icon tile marks it as Ariadne's work.
 *
 * Cancel is a button, not a link (it mutates — INV-40). The cancelled state is
 * authoritative from `cancelledByEvent` (the matching cancelled patch); the
 * local optimistic flip only fast-paths the clicking member's own feedback
 * (INV-63: the card state change is the confirmation, no success toast). A stale
 * click on an already-fired follow-up is a server-side no-op and must NOT
 * mislabel the card, so it does not flip locally.
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

  let statusIcon: ReactNode = null
  if (cancelling) statusIcon = <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
  else if (cancelled) statusIcon = <Check className="h-3 w-3" aria-hidden="true" />

  async function handleCancel() {
    // Re-entrancy guard replaces a native `disabled` attribute, which would blur
    // the focused button (browsers drop focus on disable) — `aria-disabled`
    // keeps it in the focus tree.
    if (!payload || cancelling || cancelled) return
    setCancelling(true)
    try {
      const { cancelled: didCancel } = await agentFollowUpsApi.cancel(workspaceId, payload.followUpId)
      if (didCancel) {
        setOptimisticallyCancelled(true)
      } else {
        // Lost the race (already fired, or cancelled elsewhere). Don't flip —
        // that would durably mislabel a fired follow-up. `cancelledByEvent`
        // covers a real cancel-by-another.
        toast.info("This follow-up already fired or was cancelled")
      }
    } catch {
      toast.error("Couldn't cancel the follow-up")
    } finally {
      setCancelling(false)
    }
  }

  return (
    <div className="px-3 sm:px-6 py-1.5">
      <div
        className={cn(
          "flex items-center gap-3 rounded-[10px] border px-3 py-2 transition-colors",
          cancelled ? "border-border/60 bg-muted/20" : "border-border bg-muted/40"
        )}
      >
        <span
          className={cn(
            "flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-colors",
            cancelled ? "bg-muted text-muted-foreground" : "bg-primary/10 text-primary"
          )}
        >
          <Clock className="h-4 w-4" aria-hidden="true" />
        </span>

        <div className="min-w-0 flex-1">
          <p
            className={cn(
              "truncate text-[13px] font-medium",
              cancelled ? "text-muted-foreground line-through" : "text-foreground/90"
            )}
          >
            {payload.note}
          </p>
          <p className="mt-0.5 truncate text-[11px] text-muted-foreground" title={formatFullDateTime(scheduledFor)}>
            {actorName} · fires {formatFireTime(scheduledFor)}
          </p>
        </div>

        <button
          type="button"
          onClick={handleCancel}
          aria-disabled={cancelled || cancelling}
          aria-busy={cancelling}
          aria-live="polite"
          className={cn(
            "inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-medium text-muted-foreground transition-colors",
            cancelled || cancelling ? "cursor-default" : "hover:bg-muted hover:text-foreground"
          )}
        >
          {statusIcon}
          {cancelled ? "Cancelled" : "Cancel"}
        </button>
      </div>
    </div>
  )
}
