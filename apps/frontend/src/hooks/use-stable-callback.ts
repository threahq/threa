import { useCallback, useRef } from "react"

/**
 * An identity-stable wrapper that always calls the latest `callback`. For event
 * handlers handed to memoized children; never call the result during render.
 */
export function useStableCallback<Args extends unknown[], Result>(
  callback: (...args: Args) => Result
): (...args: Args) => Result {
  const latest = useRef(callback)
  latest.current = callback
  return useCallback((...args: Args) => latest.current(...args), [])
}
