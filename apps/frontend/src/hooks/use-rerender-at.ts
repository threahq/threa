import { useEffect, useReducer } from "react"

// setTimeout fires almost immediately past its signed-32-bit ceiling.
const MAX_TIMEOUT_MS = 2_147_483_647

/**
 * Re-renders the caller once `instant` passes, so a memoized component whose
 * output is masked at render time (an expired status, a lapsed pause) drops it
 * on time instead of waiting for an unrelated re-render.
 */
export function useRerenderAt(instant: string | null | undefined): void {
  const [tick, rerender] = useReducer((n: number) => n + 1, 0)

  useEffect(() => {
    if (!instant) return
    const delay = new Date(instant).getTime() - Date.now()
    if (delay <= 0) return
    // A clamped timer re-renders early; the new tick re-arms it for the rest.
    const timer = setTimeout(rerender, Math.min(delay, MAX_TIMEOUT_MS))
    return () => clearTimeout(timer)
  }, [instant, tick])
}
