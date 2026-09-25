import { useCallback, useRef, useState, type MouseEvent, type TouchEvent } from "react"
import { useTouchCapable } from "@/hooks/use-touch-capable"
import { useLongPress } from "@/hooks/use-long-press"
import { useSwipeAction } from "@/hooks/use-swipe-action"

interface UseSidebarItemDrawerOptions {
  canOpenDrawer: boolean
  collapseOnMobile: () => void
  /** Swipe the row right to fire this. Right, because a left swipe closes the sidebar. */
  onSwipeRight?: () => void
}

export function useSidebarItemDrawer({ canOpenDrawer, collapseOnMobile, onSwipeRight }: UseSidebarItemDrawerOptions) {
  // Long-press is an additive touch gesture, so it's enabled whenever a finger
  // could be used (capability) — a mouse never fires it.
  const touchCapable = useTouchCapable()
  const preventNavigationUntilRef = useRef(0)
  const [drawerOpen, setDrawerOpen] = useState(false)

  const openDrawer = useCallback(() => {
    if (!canOpenDrawer) return
    preventNavigationUntilRef.current = Date.now() + 750
    setDrawerOpen(true)
  }, [canOpenDrawer])

  const longPress = useLongPress({
    onLongPress: openDrawer,
    enabled: touchCapable && canOpenDrawer,
  })

  const swipe = useSwipeAction({
    direction: "right",
    onSwipe: () => {
      preventNavigationUntilRef.current = Date.now() + 750
      onSwipeRight?.()
    },
    enabled: touchCapable && !!onSwipeRight,
  })

  const touchHandlers = touchCapable
    ? {
        onTouchStart: (e: TouchEvent) => {
          longPress.handlers.onTouchStart(e)
          swipe.handlers.onTouchStart(e)
        },
        onTouchMove: (e: TouchEvent) => {
          longPress.handlers.onTouchMove(e)
          swipe.handlers.onTouchMove(e)
        },
        onTouchEnd: () => {
          longPress.handlers.onTouchEnd()
          swipe.handlers.onTouchEnd()
        },
        onTouchCancel: () => {
          longPress.handlers.onTouchCancel()
          swipe.handlers.onTouchCancel()
        },
        onContextMenu: longPress.handlers.onContextMenu,
      }
    : undefined

  const handleClick = useCallback(
    (e: MouseEvent<HTMLAnchorElement>) => {
      if (preventNavigationUntilRef.current > Date.now()) {
        e.preventDefault()
        e.stopPropagation()
        return
      }
      collapseOnMobile()
    },
    [collapseOnMobile]
  )

  return {
    drawerOpen,
    setDrawerOpen,
    handleClick,
    touchCapable,
    longPress,
    touchHandlers,
    swipe,
  }
}
