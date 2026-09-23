import { type CSSProperties, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react"
import { cn } from "@/lib/utils"

/** Height growth, which outlasts the content fade; matches `.pop-in-grow` in index.css. */
export const GROW_MS = 450
/** Matches `.pop-out` in index.css. */
export const SHRINK_MS = 300
/** More new tail rows than this in one commit is a window load or a catch-up,
 *  not something arriving while the reader watches. */
const MAX_ARRIVALS_PER_COMMIT = 3

interface ArrivalTracker {
  resetKey: string
  seen: Set<string> | null
  /** `inFlight` as of the last commit, so a send confirming in the same commit a
   *  row lands above it still counts as unsent. */
  wasInFlight: ReadonlySet<string>
  arrivedAt: Map<string, number>
}

/**
 * When each row appended at the tail of `identities` arrived, keyed by identity.
 * The first render after a mount or `resetKey` change only seeds, so a list never
 * animates on load; while `enabled` is false it keeps seeding. Rows that appear
 * anywhere but after the last already-seen row (prepends, backfilled gaps, a
 * replaced window) never count.
 *
 * An identity must survive an optimistic row's swap to its server row
 * (`clientMessageId`), or the swap replays the arrival. Seen rows in `inFlight`
 * (unsent sends, which sit at the tail) don't end the tail, so a row landing
 * just above them still arrives.
 */
export function useArrivals(
  identities: readonly string[],
  resetKey: string,
  enabled: boolean,
  inFlight?: ReadonlySet<string>
): ReadonlyMap<string, number> {
  const trackerRef = useRef<ArrivalTracker | null>(null)
  if (trackerRef.current?.resetKey !== resetKey) {
    trackerRef.current = { resetKey, seen: null, wasInFlight: new Set(), arrivedAt: new Map() }
  }
  const tracker = trackerRef.current
  const { seen } = tracker

  if (enabled && seen) {
    const fresh: string[] = []
    let sawSeen = false
    for (let i = identities.length - 1; i >= 0; i--) {
      const id = identities[i]
      if (!seen.has(id)) {
        fresh.push(id)
        continue
      }
      sawSeen = true
      if (!inFlight?.has(id) && !tracker.wasInFlight.has(id)) break
    }
    if (sawSeen && fresh.length > 0 && fresh.length <= MAX_ARRIVALS_PER_COMMIT) {
      const now = performance.now()
      for (const id of fresh) if (!tracker.arrivedAt.has(id)) tracker.arrivedAt.set(id, now)
    }
  }

  useLayoutEffect(() => {
    tracker.seen = new Set(identities)
    tracker.wasInFlight = inFlight ?? new Set()
    const now = performance.now()
    for (const [id, at] of tracker.arrivedAt) if (now - at >= GROW_MS) tracker.arrivedAt.delete(id)
  })

  return tracker.arrivedAt
}

function startArrival(arrivedAt: number | undefined) {
  const elapsed = arrivedAt === undefined ? GROW_MS : performance.now() - arrivedAt
  return { arrivedAt, elapsed, growing: elapsed < GROW_MS }
}

interface PopInProps {
  /** From {@link useArrivals}; undefined for a row that was already there. */
  arrivedAt: number | undefined
  /** `x` grows the width instead, for an item joining a row. */
  axis?: "x" | "y"
  /** Plays the arrival backwards; the caller unmounts it after {@link SHRINK_MS}. */
  leaving?: boolean
  className?: string
  children: ReactNode
}

/**
 * A row that grows in from zero height, pushing its neighbours aside, while its
 * content fades in. The "new message" wash stays with `useNewMessageIndicator`,
 * which knows read state; message rows are opaque, so a wash here would never
 * show on them anyway. A remount mid-arrival (virtualized
 * scroll-away, an optimistic row's key swap) resumes from the same point rather
 * than replaying: the elapsed time is captured once and every animation starts
 * that far in.
 *
 * The inner element is always rendered so the row's DOM shape never changes when
 * the arrival ends — a shape change would remount the row's content.
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
