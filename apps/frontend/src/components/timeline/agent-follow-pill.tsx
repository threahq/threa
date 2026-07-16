import { useLayoutEffect, useRef, useState, type CSSProperties } from "react"
import { ArrowDown, ArrowUp, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useAgentActivityChipRef } from "@/contexts"
import type { FollowPillState } from "./stream-content"

const TRANSITION = "transform 240ms cubic-bezier(0.32, 0.72, 0.36, 1), opacity 240ms ease"
const EXIT_MS = 240

/**
 * Floating "agent is working" pill: shown over the timeline while a running
 * session's card is scrolled out of view. Clicking jumps to the card. Positioned
 * as a pointer-events-none overlay sibling of the scroller (INV-21) below the
 * date pill, dropping under the unread banner when that is also visible.
 *
 * The pill animates out of (and back into) the header chip so the affordance
 * reads as an extension of it rather than appearing from thin air. The chip's
 * element arrives via `useAgentActivityChipRef`; when it isn't mounted the pill
 * falls back to a plain fade from just above its slot.
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
  const chipRef = useAgentActivityChipRef()
  const wrapRef = useRef<HTMLDivElement | null>(null)
  // Keep the last content around during the exit animation.
  const lastStateRef = useRef<FollowPillState | null>(state)
  if (state) lastStateRef.current = state
  const [exiting, setExiting] = useState(false)
  const [animStyle, setAnimStyle] = useState<CSSProperties>({})
  const visibleRef = useRef(Boolean(state))

  useLayoutEffect(() => {
    const was = visibleRef.current
    const is = Boolean(state)
    visibleRef.current = is
    if (is === was) return

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    const fromChip = (): { dx: number; dy: number } => {
      const chip = chipRef.current
      const el = wrapRef.current
      if (!chip || !el) return { dx: 0, dy: -24 }
      const c = chip.getBoundingClientRect()
      const p = el.getBoundingClientRect()
      return { dx: c.left + c.width / 2 - (p.left + p.width / 2), dy: c.top + c.height / 2 - (p.top + p.height / 2) }
    }
    const atChip = (): CSSProperties => {
      if (reduceMotion) return { opacity: 0, transition: "opacity 160ms ease" }
      const { dx, dy } = fromChip()
      return { transform: `translate(${dx}px, ${dy}px) scale(0.35)`, opacity: 0, transition: TRANSITION }
    }

    if (is) {
      setExiting(false)
      // Start collapsed at the chip with no transition, then release to rest —
      // the double rAF makes sure the initial frame is committed first.
      setAnimStyle({ ...atChip(), transition: "none" })
      let raf2 = 0
      const raf1 = requestAnimationFrame(() => {
        raf2 = requestAnimationFrame(() => setAnimStyle({ transform: "none", opacity: 1, transition: TRANSITION }))
      })
      return () => {
        cancelAnimationFrame(raf1)
        cancelAnimationFrame(raf2)
      }
    }

    setExiting(true)
    setAnimStyle(atChip())
    const timer = setTimeout(() => setExiting(false), EXIT_MS)
    return () => clearTimeout(timer)
  }, [state, chipRef])

  const rendered = state ?? (exiting ? lastStateRef.current : null)
  if (!rendered) return null

  const Arrow = rendered.direction === "up" ? ArrowUp : ArrowDown
  const label = rendered.personaName ? `${rendered.personaName} is working` : `${rendered.count} agents working`

  return (
    <div
      ref={wrapRef}
      className="pointer-events-none absolute left-1/2 z-10 -translate-x-1/2"
      style={{ top: belowUnreadBanner ? "6.25rem" : "3.5rem" }}
    >
      <Button
        variant="secondary"
        size="sm"
        className={exiting ? "gap-1.5 shadow-lg" : "pointer-events-auto gap-1.5 shadow-lg"}
        style={animStyle}
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
