import { useRef, useCallback, useState, useEffect } from "react"

interface UseSwipeActionOptions {
  /** Minimum horizontal distance (px) to trigger the action (default: 80) */
  threshold?: number
  /** Called when the user swipes past the threshold and releases */
  onSwipe: () => void
  /**
   * The L: once the swipe is locked, dragging the finger down by
   * `downThreshold` switches the release to this action instead. Absent, the
   * gesture is a plain swipe and vertical drift after the lock is ignored.
   */
  onSwipeDown?: () => void
  /** Vertical distance (px) after the lock that switches to `onSwipeDown` (default: 24) */
  downThreshold?: number
  /** Disable the hook */
  enabled?: boolean
}

interface SwipeHandlers {
  onTouchStart: (e: React.TouchEvent) => void
  onTouchEnd: () => void
  onTouchMove: (e: React.TouchEvent) => void
  onTouchCancel: () => void
}

export type SwipeArm = "primary" | "down"

interface UseSwipeActionReturn {
  handlers: SwipeHandlers
  /** Current horizontal offset (negative = swiped left) */
  offset: number
  /** Whether the user has passed the threshold */
  isLocked: boolean
  /** Which action a release fires while locked: the swipe's own, or the L's. */
  arm: SwipeArm
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
  onSwipeDown,
  downThreshold = 24,
  enabled = true,
}: UseSwipeActionOptions): UseSwipeActionReturn {
  const startPos = useRef<{ x: number; y: number } | null>(null)
  const isHorizontalRef = useRef<boolean | null>(null)
  const lockedRef = useRef(false)
  // The finger's y at the moment of the lock: the L's leg is measured from
  // there, not from the touch start, so the drift that happens during the
  // horizontal stroke never counts as the downward one.
  const lockYRef = useRef(0)
  const armRef = useRef<SwipeArm>("primary")
  const [offset, setOffset] = useState(0)
  const [isLocked, setIsLocked] = useState(false)
  const [arm, setArm] = useState<SwipeArm>("primary")

  const onSwipeRef = useRef(onSwipe)
  onSwipeRef.current = onSwipe
  const onSwipeDownRef = useRef(onSwipeDown)
  onSwipeDownRef.current = onSwipeDown

  const reset = useCallback(() => {
    startPos.current = null
    isHorizontalRef.current = null
    lockedRef.current = false
    armRef.current = "primary"
    setOffset(0)
    setIsLocked(false)
    setArm("primary")
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
        lockYRef.current = touch.clientY
        setIsLocked(true)
        try {
          navigator.vibrate?.(10)
        } catch {
          // Ignore
        }
      } else if (Math.abs(clampedOffset) < threshold && lockedRef.current) {
        lockedRef.current = false
        armRef.current = "primary"
        setIsLocked(false)
        setArm("primary")
      }

      // The L's leg: down from the lock point arms the second action, back up
      // disarms it. One buzz per arming so the switch is felt, not just seen.
      if (lockedRef.current && onSwipeDownRef.current) {
        const nextArm: SwipeArm = touch.clientY - lockYRef.current >= downThreshold ? "down" : "primary"
        if (nextArm !== armRef.current) {
          armRef.current = nextArm
          setArm(nextArm)
          if (nextArm === "down") {
            try {
              navigator.vibrate?.(10)
            } catch {
              // Ignore
            }
          }
        }
      }
    },
    [enabled, threshold, downThreshold, reset]
  )

  const onTouchEnd = useCallback(() => {
    if (lockedRef.current) {
      if (armRef.current === "down" && onSwipeDownRef.current) onSwipeDownRef.current()
      else onSwipeRef.current()
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
    arm,
  }
}
