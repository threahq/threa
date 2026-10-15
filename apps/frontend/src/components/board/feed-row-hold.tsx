import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react"

type Hold = (rowKey: string) => () => void

export const FeedRowHoldContext = createContext<Hold | null>(null)
export const FeedRowKeyContext = createContext<string | null>(null)

/** The feed rows something inside holds mounted, and the `hold` that rows below report through. */
export function useFeedRowHolds(): { held: ReadonlySet<string>; hold: Hold } {
  const counts = useRef(new Map<string, number>())
  const [held, setHeld] = useState<ReadonlySet<string>>(() => new Set())
  const hold = useCallback<Hold>((rowKey) => {
    const count = counts.current.get(rowKey) ?? 0
    counts.current.set(rowKey, count + 1)
    if (count === 0) setHeld((prev) => new Set(prev).add(rowKey))
    return () => {
      const remaining = (counts.current.get(rowKey) ?? 1) - 1
      if (remaining > 0) {
        counts.current.set(rowKey, remaining)
        return
      }
      counts.current.delete(rowKey)
      setHeld((prev) => {
        const next = new Set(prev)
        next.delete(rowKey)
        return next
      })
    }
  }, [])
  return { held, hold }
}

/** Keeps the feed row this renders in mounted while `active`, where a virtualized feed would drop it off-screen. */
export function useHoldFeedRow(active: boolean) {
  const hold = useContext(FeedRowHoldContext)
  const rowKey = useContext(FeedRowKeyContext)
  useEffect(() => {
    if (active && hold && rowKey) return hold(rowKey)
  }, [active, hold, rowKey])
}
