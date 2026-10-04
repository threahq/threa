import { useCallback, useInsertionEffect, useRef } from "react"

/**
 * An identity-stable wrapper that always calls the latest committed `callback`.
 * For event handlers handed to memoized children; never call the result during
 * render.
 */
export function useStableCallback<Args extends unknown[], Result>(
  callback: (...args: Args) => Result
): (...args: Args) => Result {
  const latest = useRef(callback)
  // On commit, never during render: a navigation renders inside a transition
  // that can sit uncommitted for seconds, and a render-phase write would hand
  // the next stream's handler to the composer still on screen.
  useInsertionEffect(() => {
    latest.current = callback
  })
  return useCallback((...args: Args) => latest.current(...args), [])
}
