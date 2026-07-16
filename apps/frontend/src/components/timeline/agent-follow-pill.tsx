import { useEffect, useRef, useState } from "react"
import { ArrowDown, ArrowUp, Loader2 } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import type { FollowPillState } from "./stream-content"

const EXIT_MS = 160

/**
 * Floating "agent is working" pill: shown over the timeline while a running
 * session's card is scrolled out of view. Clicking jumps to the card. Positioned
 * as a pointer-events-none overlay sibling of the scroller (INV-21) below the
 * date pill, dropping under the unread banner when that is also visible.
 *
 * Appears sticky-header style: a quick fade with a slight downward settle from
 * the top edge — as if the card that just scrolled away condensed into it — and
 * fades back out when the card returns or the session ends.
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
  // Keep the last content around during the exit fade.
  const lastStateRef = useRef<FollowPillState | null>(state)
  if (state) lastStateRef.current = state
  const [phase, setPhase] = useState<"in" | "shown" | "out" | "gone">(state ? "shown" : "gone")
  const visibleRef = useRef(Boolean(state))

  useEffect(() => {
    const was = visibleRef.current
    const is = Boolean(state)
    visibleRef.current = is
    if (is === was) return
    if (is) {
      // Mount hidden for one frame so the transition to "shown" animates.
      setPhase("in")
      const raf = requestAnimationFrame(() => setPhase("shown"))
      return () => cancelAnimationFrame(raf)
    }
    setPhase("out")
    const timer = setTimeout(() => setPhase("gone"), EXIT_MS)
    return () => clearTimeout(timer)
  }, [state])

  const rendered = state ?? (phase !== "gone" ? lastStateRef.current : null)
  if (!rendered || phase === "gone") return null

  const Arrow = rendered.direction === "up" ? ArrowUp : ArrowDown
  const label = rendered.personaName ? `${rendered.personaName} is working` : `${rendered.count} agents working`

  return (
    <div
      className="pointer-events-none absolute left-1/2 z-10 -translate-x-1/2"
      style={{ top: belowUnreadBanner ? "6.25rem" : "3.5rem" }}
    >
      <Button
        variant="secondary"
        size="sm"
        className={cn(
          "gap-1.5 shadow-lg transition-[opacity,transform] duration-200 ease-out motion-reduce:transition-opacity",
          phase === "shown" ? "pointer-events-auto translate-y-0 opacity-100" : "-translate-y-1.5 opacity-0"
        )}
        onClick={() => onFollow(rendered.anchorId)}
      >
        <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" aria-hidden />
        <span>{label}</span>
        {rendered.personaName && rendered.stepCount > 0 && (
          <span className="text-muted-foreground">
            · {rendered.stepCount} step{rendered.stepCount === 1 ? "" : "s"}
          </span>
        )}
        <Arrow className="h-3.5 w-3.5" aria-hidden />
      </Button>
    </div>
  )
}
