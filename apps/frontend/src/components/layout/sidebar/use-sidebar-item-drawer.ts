import { useCallback, useRef, useState, type MouseEvent } from "react"
import { useTouchCapable } from "@/hooks/use-touch-capable"
import { useLongPress } from "@/hooks/use-long-press"

interface UseSidebarItemDrawerOptions {
  canOpenDrawer: boolean
  collapseOnMobile: () => void
}

export function useSidebarItemDrawer({ canOpenDrawer, collapseOnMobile }: UseSidebarItemDrawerOptions) {
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
  }
}
