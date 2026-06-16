import { useRef, useState, useEffect } from "react"

/** Exclude touches from the very screen edge to avoid OS back-gesture conflicts (px) */
const OS_GESTURE_ZONE = 8

/** Movement before direction is locked (px) */
const LOCK_THRESHOLD = 10

/** Velocity that forces open/close regardless of position (px/ms) */
const VELOCITY_THRESHOLD = 0.3

/** Fraction of sidebar width past which a swipe commits (50% = halfway) */
const POSITION_THRESHOLD = 0.5

/** Duration of snap animation after releasing (ms) */
const SNAP_MS = 200

interface SwipeTracker {
  startX: number
  startY: number
  currentX: number
  locked: boolean
  horizontal: boolean
  opening: boolean
  lastX: number
  lastTime: number
  velocity: number
}

interface UseSidebarSwipeOptions {
  isOpen: boolean
  isMobile: boolean
  onOpen: () => void
  onClose: () => void
}

/**
 * Swipe gestures for the mobile sidebar.
 *
 * - Swipe right from anywhere → open (excludes OS gesture zone at screen edge)
 * - Swipe left from anywhere → close
 * - Finger-tracking at 60fps via imperative DOM updates (no React re-renders during gesture)
 * - Velocity + position threshold decides open/close on release
 *
 * Returns refs to attach to the sidebar `<aside>` and backdrop `<div>`,
 * plus an `isSwiping` boolean to suppress CSS transitions during gestures.
 */
export function useSidebarSwipe({ isOpen, isMobile, onOpen, onClose }: UseSidebarSwipeOptions) {
  const [isSwiping, setIsSwiping] = useState(false)
  const sidebarRef = useRef<HTMLElement>(null)
  const backdropRef = useRef<HTMLDivElement>(null)
  const trackerRef = useRef<SwipeTracker | null>(null)
  const snapTimeoutRef = useRef<number | null>(null)
  const clearStylesRafRef = useRef<number | null>(null)

  // Latest values in a ref so event handlers always read current state
  const stateRef = useRef({ isOpen, onOpen, onClose })
  stateRef.current = { isOpen, onOpen, onClose }

  // After swipe ends and isSwiping becomes false, clear residual inline styles.
  // This runs after React has painted the CSS classes, so removing the inline
  // styles that were set during the gesture is safe (no flash).
  useEffect(() => {
    if (!isSwiping && isMobile) {
      clearStylesRafRef.current = requestAnimationFrame(() => {
        clearStylesRafRef.current = null
        if (sidebarRef.current) {
          sidebarRef.current.style.transform = ""
          sidebarRef.current.style.transition = ""
        }
        if (backdropRef.current) {
          backdropRef.current.style.opacity = ""
          backdropRef.current.style.pointerEvents = ""
          backdropRef.current.style.transition = ""
        }
      })
    }
    return () => {
      if (clearStylesRafRef.current !== null) {
        cancelAnimationFrame(clearStylesRafRef.current)
        clearStylesRafRef.current = null
      }
    }
  }, [isSwiping, isMobile])

  useEffect(() => {
    if (!isMobile) return

    const sidebarWidth = () => sidebarRef.current?.offsetWidth ?? 280

    // Track a frozen scroll container so we can restore it on gesture end
    let frozenScroller: HTMLElement | null = null
    let frozenOverflowY = ""

    const freezeScrolling = (target: EventTarget | null) => {
      const scroller = findVerticalScroller(target as Element | null)
      if (scroller) {
        frozenScroller = scroller
        frozenOverflowY = scroller.style.overflowY
        scroller.style.overflowY = "hidden"
      }
    }

    const unfreezeScrolling = () => {
      if (frozenScroller) {
        frozenScroller.style.overflowY = frozenOverflowY
        frozenScroller = null
        frozenOverflowY = ""
      }
    }

    /** Set sidebar transform + backdrop opacity directly on DOM */
    const applyVisuals = (progress: number) => {
      const p = Math.max(0, Math.min(1, progress))
      if (sidebarRef.current) {
        sidebarRef.current.style.transform = `translateX(${(p - 1) * 100}%)`
      }
      if (backdropRef.current) {
        backdropRef.current.style.opacity = String(p)
        backdropRef.current.style.pointerEvents = p > 0.01 ? "auto" : "none"
      }
    }

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length > 1) {
        trackerRef.current = null
        return
      }

      const { isOpen } = stateRef.current
      const touch = e.touches[0]

      // Swipe-to-open: ignore touches from the very edge (OS back-gesture territory)
      if (!isOpen && touch.clientX < OS_GESTURE_ZONE) return

      // Don't capture swipes that start on horizontally scrollable elements
      // (e.g. editor style bar, code blocks inside the sidebar) — let them scroll natively
      if (hasHorizontalScroll(touch.target as Element | null)) return

      // Don't capture swipes inside modal overlays (e.g. image gallery dialog)
      if (isInsideModalOverlay(touch.target as Element | null)) return

      trackerRef.current = {
        startX: touch.clientX,
        startY: touch.clientY,
        currentX: touch.clientX,
        locked: false,
        horizontal: false,
        opening: !isOpen,
        lastX: touch.clientX,
        lastTime: performance.now(),
        velocity: 0,
      }
    }

    const onTouchMove = (e: TouchEvent) => {
      const t = trackerRef.current
      if (!t) return

      if (e.touches.length > 1) {
        trackerRef.current = null
        unfreezeScrolling()
        if (sidebarRef.current?.style.transform) {
          sidebarRef.current.style.transform = ""
          sidebarRef.current.style.transition = ""
        }
        if (backdropRef.current?.style.opacity) {
          backdropRef.current.style.opacity = ""
          backdropRef.current.style.pointerEvents = ""
          backdropRef.current.style.transition = ""
        }
        setIsSwiping(false)
        return
      }

      const touch = e.touches[0]
      const dx = touch.clientX - t.startX
      const dy = touch.clientY - t.startY

      // Direction lock phase
      if (!t.locked) {
        const adx = Math.abs(dx)
        const ady = Math.abs(dy)
        if (adx < LOCK_THRESHOLD && ady < LOCK_THRESHOLD) return

        t.locked = true

        // For opening: require clearly horizontal movement (1.5× bias)
        // to avoid hijacking diagonal scrolling in content areas.
        // For closing: normal threshold (backdrop has nothing to scroll).
        t.horizontal = t.opening ? adx > ady * 1.5 : adx > ady

        // Validate: opening must move right, closing must move left
        if (t.horizontal) {
          if (t.opening && dx <= 0) t.horizontal = false
          if (!t.opening && dx >= 0) t.horizontal = false
        }

        if (!t.horizontal) {
          trackerRef.current = null
          return
        }

        // Cancel any pending snap timeout from a previous gesture so it
        // doesn't fire setIsSwiping(false) mid-swipe and clear our styles
        if (snapTimeoutRef.current !== null) {
          window.clearTimeout(snapTimeoutRef.current)
          snapTimeoutRef.current = null
        }

        // Prevent scrolling: call preventDefault on the locking frame AND
        // freeze the nearest scroll container (the compositor may have already
        // started scrolling before our JS handler ran)
        e.preventDefault()
        freezeScrolling(e.target)

        // Update tracker on the locking frame so touchend has valid
        // position/velocity even for fast single-frame flicks
        const now = performance.now()
        const dt = now - t.lastTime
        if (dt > 0) {
          t.velocity = (touch.clientX - t.lastX) / dt
        }
        t.currentX = touch.clientX
        t.lastX = touch.clientX
        t.lastTime = now

        // Set initial visuals before React re-render to prevent flash
        const w = sidebarWidth()
        applyVisuals(t.opening ? Math.max(0, dx) / w : 1 + Math.min(0, dx) / w)
        setIsSwiping(true)
        return
      }

      if (!t.horizontal) return
      e.preventDefault()

      const now = performance.now()
      const dt = now - t.lastTime
      if (dt > 0) {
        t.velocity = (touch.clientX - t.lastX) / dt
        t.lastX = touch.clientX
        t.lastTime = now
      }
      t.currentX = touch.clientX

      const w = sidebarWidth()
      applyVisuals(t.opening ? Math.max(0, dx) / w : 1 + Math.min(0, dx) / w)
    }

    const onTouchEnd = () => {
      const t = trackerRef.current
      trackerRef.current = null
      unfreezeScrolling()

      if (!t || !t.locked || !t.horizontal) {
        // Only clear isSwiping if no snap animation is pending from a previous
        // gesture — otherwise we'd prematurely trigger the clear-styles effect
        // and cause a visible jump mid-animation.
        if (snapTimeoutRef.current === null) {
          setIsSwiping(false)
        }
        return
      }

      const w = sidebarWidth()
      const dx = t.currentX - t.startX

      const shouldComplete = t.opening
        ? dx / w > POSITION_THRESHOLD || t.velocity > VELOCITY_THRESHOLD
        : Math.abs(dx) / w > POSITION_THRESHOLD || t.velocity < -VELOCITY_THRESHOLD

      if (sidebarRef.current) sidebarRef.current.style.transition = `transform ${SNAP_MS}ms ease-out`
      if (backdropRef.current) backdropRef.current.style.transition = `opacity ${SNAP_MS}ms ease-out`

      if (shouldComplete) {
        applyVisuals(t.opening ? 1 : 0)
      } else {
        applyVisuals(t.opening ? 0 : 1)
      }

      // Wait for snap animation, then update React state.
      // Batching onOpen/onClose with setIsSwiping(false) ensures CSS classes
      // are evaluated with both isOpen and isSwiping correct in a single render.
      // Read callbacks from stateRef inside the timeout (not before) so they
      // reflect any re-renders that happened during the snap animation.
      const opening = t.opening
      window.clearTimeout(snapTimeoutRef.current ?? undefined)
      snapTimeoutRef.current = window.setTimeout(() => {
        if (shouldComplete) {
          const { onOpen, onClose } = stateRef.current
          opening ? onOpen() : onClose()
        }
        snapTimeoutRef.current = null
        setIsSwiping(false)
      }, SNAP_MS + 20)
    }

    document.addEventListener("touchstart", onTouchStart, { passive: true })
    document.addEventListener("touchmove", onTouchMove, { passive: false })
    document.addEventListener("touchend", onTouchEnd)
    document.addEventListener("touchcancel", onTouchEnd)

    return () => {
      document.removeEventListener("touchstart", onTouchStart)
      document.removeEventListener("touchmove", onTouchMove)
      document.removeEventListener("touchend", onTouchEnd)
      document.removeEventListener("touchcancel", onTouchEnd)
      window.clearTimeout(snapTimeoutRef.current ?? undefined)
      snapTimeoutRef.current = null
      unfreezeScrolling()
      setIsSwiping(false)
      if (sidebarRef.current) {
        sidebarRef.current.style.transform = ""
        sidebarRef.current.style.transition = ""
      }
      if (backdropRef.current) {
        backdropRef.current.style.opacity = ""
        backdropRef.current.style.pointerEvents = ""
        backdropRef.current.style.transition = ""
      }
    }
  }, [isMobile])

  return { isSwiping, sidebarRef, backdropRef }
}

/** Walk up the DOM to find the nearest vertically scrollable ancestor */
function findVerticalScroller(el: Element | null): HTMLElement | null {
  let node = el
  while (node && node !== document.documentElement) {
    if (node instanceof HTMLElement && node.scrollHeight > node.clientHeight) {
      const { overflowY } = getComputedStyle(node)
      if (overflowY === "auto" || overflowY === "scroll") return node
    }
    node = node.parentElement
  }
  return null
}

/** Walk up the DOM checking if the touch target is inside a modal dialog overlay */
function isInsideModalOverlay(el: Element | null): boolean {
  let node = el
  while (node && node !== document.documentElement) {
    if (node instanceof HTMLElement && node.getAttribute("role") === "dialog") return true
    node = node.parentElement
  }
  return false
}

/** Walk up the DOM checking if any ancestor can scroll horizontally */
function hasHorizontalScroll(el: Element | null): boolean {
  let node = el
  while (node && node !== document.documentElement) {
    if (node.scrollWidth > node.clientWidth) {
      const { overflowX } = getComputedStyle(node)
      if (overflowX === "auto" || overflowX === "scroll") return true
    }
    node = node.parentElement
  }
  return false
}
