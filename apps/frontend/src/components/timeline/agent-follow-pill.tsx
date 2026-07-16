import { ArrowDown, ArrowUp, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { FollowPillState } from "./stream-content"

/**
 * Floating "agent is working" pill: shown over the timeline while a running
 * session's card is scrolled out of view. Clicking jumps to the card. Positioned
 * as a pointer-events-none overlay sibling of the scroller (INV-21) below the
 * date pill, dropping under the unread banner when that is also visible.
 */
export function AgentFollowPill({
  state,
  belowUnreadBanner,
  onFollow,
}: {
  state: FollowPillState | null
  /** Sit below the unread banner (top: 3.5rem) when it's showing, else take its slot. */
  belowUnreadBanner: boolean
  onFollow: (anchorId: string) => void
}) {
  if (!state) return null

  const Arrow = state.direction === "up" ? ArrowUp : ArrowDown
  const label = state.personaName ? `${state.personaName} is working` : `${state.count} agents working`

  return (
    <div
      className="pointer-events-none absolute left-1/2 z-10 -translate-x-1/2"
      style={{ top: belowUnreadBanner ? "6.25rem" : "3.5rem" }}
    >
      <Button
        variant="secondary"
        size="sm"
        className="pointer-events-auto gap-1.5 shadow-lg"
        onClick={() => onFollow(state.anchorId)}
      >
        <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" aria-hidden />
        <span>{label}</span>
        {state.personaName && state.stepCount > 0 && (
          <span className="text-muted-foreground">
            · {state.stepCount} step{state.stepCount === 1 ? "" : "s"}
          </span>
        )}
        <Arrow className="h-3.5 w-3.5" aria-hidden />
      </Button>
    </div>
  )
}
