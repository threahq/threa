import { useCallback, useLayoutEffect, useRef } from "react"

/** A stable getter of the latest `value`, for event handlers that must not re-render their component on its changes. */
export function useLatest<T>(value: T): () => T {
  const ref = useRef(value)
  useLayoutEffect(() => {
    ref.current = value
  })
  return useCallback(() => ref.current, [])
}
