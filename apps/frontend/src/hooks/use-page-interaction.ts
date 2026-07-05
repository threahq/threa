import { useEffect, useRef } from "react"

export interface PageInteractionTracker {
  /** Timestamp of the most recent user interaction (ms since epoch), or 0. */
  getLastInteractionAt: () => number
  /** Subscribe to interaction events. Returns an unsubscribe function. */
  subscribe: (cb: () => void) => () => void
}

/**
 * Tracks pointer/key/touch/wheel interactions on the document. State is stored
 * in refs so mouse movement doesn't re-render consumers — callers read the
 * timestamp at heartbeat time and may subscribe to the event stream to drive
 * their own throttled "user resumed activity" signal.
 */
export function usePageInteraction(): PageInteractionTracker {
  const lastInteractionAtRef = useRef(0)
  const listenersRef = useRef(new Set<() => void>())
  const trackerRef = useRef<PageInteractionTracker>({
    getLastInteractionAt: () => lastInteractionAtRef.current,
    subscribe: (cb) => {
      listenersRef.current.add(cb)
      return () => {
        listenersRef.current.delete(cb)
      }
    },
  })

  useEffect(() => {
    if (typeof window === "undefined") return

    const handle = () => {
      lastInteractionAtRef.current = Date.now()
      for (const cb of listenersRef.current) cb()
    }

    // `wheel` counts reading: desktop scrolling fires no pointerdown/keydown,
    // so without it a user reading a long stream "ages out" of presence after
    // 2 minutes and gets pushed for the very stream they're looking at. It is
    // deliberately `wheel` (hardware input) and NOT `scroll` — programmatic
    // scrolls (auto-follow on new messages, virtualizer adjustments) fire
    // `scroll` on an abandoned-but-focused tab and would fake presence,
    // which is exactly what this interaction gate exists to prevent.
    const opts: AddEventListenerOptions = { passive: true, capture: true }
    window.addEventListener("pointerdown", handle, opts)
    window.addEventListener("keydown", handle, opts)
    window.addEventListener("touchstart", handle, opts)
    window.addEventListener("wheel", handle, opts)

    return () => {
      window.removeEventListener("pointerdown", handle, opts)
      window.removeEventListener("keydown", handle, opts)
      window.removeEventListener("touchstart", handle, opts)
      window.removeEventListener("wheel", handle, opts)
    }
  }, [])

  return trackerRef.current
}
