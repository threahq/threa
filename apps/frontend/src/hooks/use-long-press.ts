import { useRef, useCallback, useState, useEffect } from "react"

interface UseLongPressOptions {
  /** Duration in ms before long press fires (default: 500) */
  threshold?: number
  /** Called when long press is detected */
  onLongPress: () => void
  /** Disable the hook (e.g., on desktop) */
  enabled?: boolean
  /**
   * When true, skip the long-press timer if the touch starts inside an
   * <a href> or an element marked data-native-context="true" (e.g. code
   * blocks). Use on container-level long-press handlers (e.g. a message
   * body) where child links / code blocks should get the browser's native
   * long-press menu — "Open in Firefox" / "Copy link" for links, native
   * text selection for code — rather than the app's message drawer. Do
   * not enable when the long-press handler is attached directly to the
   * link itself (e.g. a sidebar stream row). Default: false.
   */
  deferToNativeLinks?: boolean
}

interface LongPressHandlers {
  onTouchStart: (e: React.TouchEvent) => void
  onTouchEnd: () => void
  onTouchMove: (e: React.TouchEvent) => void
  onTouchCancel: () => void
  onContextMenu: (e: React.MouseEvent) => void
}

interface UseLongPressReturn {
  handlers: LongPressHandlers
  /** True while the user is holding and the timer hasn't fired yet */
  isPressed: boolean
}

export function useLongPress({
  threshold = 500,
  onLongPress,
  enabled = true,
  deferToNativeLinks = false,
}: UseLongPressOptions): UseLongPressReturn {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const startPos = useRef<{ x: number; y: number } | null>(null)
  const firedRef = useRef(false)
  const [isPressed, setIsPressed] = useState(false)

  // Refs so the timer callback reads fresh values without
  // invalidating touch handler memoization on every render.
  const onLongPressRef = useRef(onLongPress)
  onLongPressRef.current = onLongPress
  const enabledRef = useRef(enabled)
  enabledRef.current = enabled

  const clear = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    startPos.current = null
    firedRef.current = false
    setIsPressed(false)
  }, [])

  const onTouchStart = useCallback(
    (e: React.TouchEvent) => {
      if (!enabled) return
      // When deferToNativeLinks is on, let the browser's native gesture win
      // on <a href> descendants and regions marked data-native-context="true"
      // (e.g. code blocks) so long-press surfaces "Open in Firefox" / "Copy
      // link" for links, or native text selection for code, instead of the
      // app's drawer.
      if (
        deferToNativeLinks &&
        e.target instanceof Element &&
        e.target.closest('a[href], [data-native-context="true"]') !== null
      ) {
        return
      }
      firedRef.current = false
      const touch = e.touches[0]
      startPos.current = { x: touch.clientX, y: touch.clientY }
      setIsPressed(true)
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        setIsPressed(false)
        if (!enabledRef.current) return
        firedRef.current = true
        // Haptic feedback (Android; silent no-op on iOS)
        try {
          navigator.vibrate?.(10)
        } catch {
          // Ignore
        }
        onLongPressRef.current()
      }, threshold)
    },
    [enabled, threshold, deferToNativeLinks]
  )

  const onTouchEnd = useCallback(() => {
    clear()
  }, [clear])

  // `touchcancel` fires (instead of `touchend`) when the browser/OS steals the
  // gesture; clear the pending timer and pressed state so neither gets stuck.
  const onTouchCancel = useCallback(() => {
    clear()
  }, [clear])

  const onTouchMove = useCallback(
    (e: React.TouchEvent) => {
      if (!startPos.current) return
      const touch = e.touches[0]
      if (!touch) {
        clear()
        return
      }
      const dx = touch.clientX - startPos.current.x
      const dy = touch.clientY - startPos.current.y
      // Cancel if moved more than 10px (user is scrolling)
      if (Math.abs(dx) > 10 || Math.abs(dy) > 10) {
        clear()
      }
    },
    [clear]
  )

  // Suppress native context menu when a long-press is in progress
  // (timer running) or has just fired. Mobile browsers fire contextmenu
  // synchronously during the hold, before the threshold timeout.
  const onContextMenu = useCallback(
    (e: React.MouseEvent) => {
      if (enabled && (timerRef.current !== null || firedRef.current)) {
        e.preventDefault()
        firedRef.current = false
      }
    },
    [enabled]
  )

  // Cancel pending timer on unmount to avoid firing on stale closures.
  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    },
    []
  )

  return {
    handlers: { onTouchStart, onTouchEnd, onTouchMove, onTouchCancel, onContextMenu },
    isPressed,
  }
}
