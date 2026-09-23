import { type CSSProperties, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react"
import { cn } from "@/lib/utils"

/** Height growth, which outlasts the content fade; matches `.pop-in-grow` in index.css. */
const GROW_MS = 450
/** More new tail rows than this in one commit is a window load or a catch-up,
 *  not something arriving while the reader watches. */
const MAX_ARRIVALS_PER_COMMIT = 3

interface ArrivalTracker {
  resetKey: string
  seen: Set<string> | null
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
 * (`clientMessageId`), or the swap replays the arrival.
 */
export function useArrivals(
  identities: readonly string[],
  resetKey: string,
  enabled: boolean
): ReadonlyMap<string, number> {
  const trackerRef = useRef<ArrivalTracker | null>(null)
  if (trackerRef.current?.resetKey !== resetKey) {
    trackerRef.current = { resetKey, seen: null, arrivedAt: new Map() }
  }
  const tracker = trackerRef.current
  const { seen } = tracker

  if (enabled && seen) {
    const fresh: string[] = []
    let i = identities.length - 1
    while (i >= 0 && !seen.has(identities[i])) fresh.push(identities[i--])
    if (i >= 0 && fresh.length > 0 && fresh.length <= MAX_ARRIVALS_PER_COMMIT) {
      const now = performance.now()
      for (const id of fresh) if (!tracker.arrivedAt.has(id)) tracker.arrivedAt.set(id, now)
    }
  }

  useLayoutEffect(() => {
    tracker.seen = new Set(identities)
    const now = performance.now()
    for (const [id, at] of tracker.arrivedAt) if (now - at >= GROW_MS) tracker.arrivedAt.delete(id)
  })

  return tracker.arrivedAt
}

interface PopInProps {
  /** From {@link useArrivals}; undefined for a row that was already there. */
  arrivedAt: number | undefined
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
export function PopIn({ arrivedAt, className, children }: PopInProps) {
  const [elapsed] = useState(() => (arrivedAt === undefined ? GROW_MS : performance.now() - arrivedAt))
  const [growing, setGrowing] = useState(elapsed < GROW_MS)

  useEffect(() => {
    if (!growing) return
    const timer = window.setTimeout(() => setGrowing(false), GROW_MS - elapsed)
    return () => window.clearTimeout(timer)
  }, [growing, elapsed])

  const style = growing ? ({ "--pop-in-elapsed": `${Math.round(elapsed)}ms` } as CSSProperties) : undefined
  return (
    <div className={cn(className, growing && "pop-in-grow")} style={style}>
      <div className={growing ? "pop-in-fx" : undefined}>{children}</div>
    </div>
  )
}
