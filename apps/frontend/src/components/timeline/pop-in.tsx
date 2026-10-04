import { type CSSProperties, type ReactNode, useEffect, useState } from "react"
import { cn } from "@/lib/utils"

/** Height growth, which outlasts the content fade; matches `.pop-in-grow` in index.css. */
export const GROW_MS = 450
/** Matches `.pop-out` in index.css. */
export const SHRINK_MS = 300

function startArrival(arrivedAt: number | undefined) {
  const elapsed = arrivedAt === undefined ? GROW_MS : performance.now() - arrivedAt
  return { arrivedAt, elapsed, growing: elapsed < GROW_MS }
}

interface PopInProps {
  /** When the item arrived (`performance.now()`); undefined for one that was already there. */
  arrivedAt: number | undefined
  /** `x` grows the width instead, for an item joining a row. */
  axis?: "x" | "y"
  /** Plays the arrival backwards; the caller unmounts it after {@link SHRINK_MS}. */
  leaving?: boolean
  className?: string
  children: ReactNode
}

/**
 * An item that grows in from zero size, pushing its neighbours aside, while its
 * content fades in. A remount mid-arrival (virtualized scroll-away) resumes from
 * the same point rather than replaying: the elapsed time is captured once and
 * every animation starts that far in.
 *
 * The inner element is always rendered so the item's DOM shape never changes when
 * the arrival ends — a shape change would remount its content.
 */
export function PopIn({ arrivedAt, axis = "y", leaving = false, className, children }: PopInProps) {
  const [arrival, setArrival] = useState(() => startArrival(arrivedAt))
  // A new arrival on a mounted instance (a reaction re-added mid-shrink) restarts the growth.
  if (arrivedAt !== undefined && arrivedAt !== arrival.arrivedAt) setArrival(startArrival(arrivedAt))
  const { elapsed, growing } = arrival

  useEffect(() => {
    if (!arrival.growing) return
    const timer = window.setTimeout(() => setArrival({ ...arrival, growing: false }), GROW_MS - arrival.elapsed)
    return () => window.clearTimeout(timer)
  }, [arrival])

  const style = growing ? ({ "--pop-in-elapsed": `${Math.round(elapsed)}ms` } as CSSProperties) : undefined
  let motion: string | undefined
  let fx: string | undefined
  if (leaving) {
    motion = axis === "x" ? "pop-out-x" : "pop-out"
    fx = "pop-out-fx"
  } else if (growing) {
    motion = axis === "x" ? "pop-in-grow-x" : "pop-in-grow"
    fx = "pop-in-fx"
  }
  return (
    <div className={cn(className, axis === "x" && "pop-in-x", motion)} style={leaving ? undefined : style}>
      <div className={fx}>{children}</div>
    </div>
  )
}
