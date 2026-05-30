import { useRef, useCallback, useState, useEffect } from "react"

interface UseSwipeActionOptions {
  /** Minimum horizontal distance (px) to trigger the action (default: 80) */
  threshold?: number
  /** Called when the user swipes past the threshold and releases */
  onSwipe: () => void
  /** Disable the hook */
  enabled?: boolean
}

interface SwipeHandlers {
  onTouchStart: (e: React.TouchEvent) => void
  onTouchEnd: () => void
  onTouchMove: (e: React.TouchEvent) => void
  onTouchCancel: () => void
}

interface UseSwipeActionReturn {
  handlers: SwipeHandlers
  /** Current horizontal offset (negative = swiped left) */
  offset: number
  /** Whether the user has passed the threshold */
  isLocked: boolean
}

/**
 * True when the touch began inside an element that can scroll horizontally
 * (e.g. a wide code block's `<pre>` with `overflow-x: auto`). Those elements
 * consume the horizontal gesture for scrolling, so the swipe-to-quote action
 * must stay out of the way.
 */
function startedInHorizontalScroller(target: EventTarget | null): boolean {
  let node = target instanceof Element ? target : null
  while (node) {
    const overflowX = window.getComputedStyle(node).overflowX
    if ((overflowX === "auto" || overflowX === "scroll") && node.scrollWidth > node.clientWidth) {
      return true
    }
    node = node.parentElement
  }
  return false
}

/**
 * Swipe-from-right gesture for mobile quote reply.
 * The user swipes left on a message; once they cross the threshold,
 * haptic feedback fires and the action locks in. Releasing triggers the callback.
 */
export function useSwipeAction({
  threshold = 80,
  onSwipe,
  enabled = true,
}: UseSwipeActionOptions): UseSwipeActionReturn {
  const startPos = useRef<{ x: number; y: number } | null>(null)
  const isHorizontalRef = useRef<boolean | null>(null)
  const lockedRef = useRef(false)
  const [offset, setOffset] = useState(0)
  const [isLocked, setIsLocked] = useState(false)

  const onSwipeRef = useRef(onSwipe)
  onSwipeRef.current = onSwipe

  const reset = useCallback(() => {
    startPos.current = null
    isHorizontalRef.current = null
    lockedRef.current = false
    setOffset(0)
    setIsLocked(false)
  }, [])

  const onTouchStart = useCallback(
    (e: React.TouchEvent) => {
      if (!enabled) return
      if (startedInHorizontalScroller(e.target)) return
      const touch = e.touches[0]
      startPos.current = { x: touch.clientX, y: touch.clientY }
      isHorizontalRef.current = null
      lockedRef.current = false
    },
    [enabled]
  )

  const onTouchMove = useCallback(
    (e: React.TouchEvent) => {
      if (!startPos.current || !enabled) return
      const touch = e.touches[0]
      if (!touch) return

      const dx = touch.clientX - startPos.current.x
      const dy = touch.clientY - startPos.current.y

      // Determine direction once after a small movement
      if (isHorizontalRef.current === null) {
        if (Math.abs(dx) > 10 || Math.abs(dy) > 10) {
          isHorizontalRef.current = Math.abs(dx) > Math.abs(dy) && dx < 0
          if (!isHorizontalRef.current) {
            // Vertical scroll — bail out
            reset()
            return
          }
        } else {
          return
        }
      }

      if (!isHorizontalRef.current) return

      // Only track leftward swipes (negative dx), capped at threshold * 1.2
      const clampedOffset = Math.max(dx, -(threshold * 1.2))
      setOffset(clampedOffset)

      // Lock in when past threshold
      if (Math.abs(clampedOffset) >= threshold && !lockedRef.current) {
        lockedRef.current = true
        setIsLocked(true)
        try {
          navigator.vibrate?.(10)
        } catch {
          // Ignore
        }
      } else if (Math.abs(clampedOffset) < threshold && lockedRef.current) {
        lockedRef.current = false
        setIsLocked(false)
      }
    },
    [enabled, threshold, reset]
  )

  const onTouchEnd = useCallback(() => {
    if (lockedRef.current) {
      onSwipeRef.current()
    }
    reset()
  }, [reset])

  // The browser/OS can steal an in-flight touch (system gesture navigation,
  // scroll takeover, a second finger), in which case it fires `touchcancel`
  // instead of `touchend`. Without this the offset would stay frozen and the
  // message would remain visibly shifted left. Snap back without triggering
  // the action — a cancelled gesture is not a deliberate swipe.
  const onTouchCancel = useCallback(() => {
    reset()
  }, [reset])

  useEffect(() => reset, [reset])

  return {
    handlers: { onTouchStart, onTouchEnd, onTouchMove, onTouchCancel },
    offset,
    isLocked,
  }
}
