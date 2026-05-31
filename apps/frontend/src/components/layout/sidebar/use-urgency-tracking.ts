import { useLayoutEffect, type RefObject } from "react"
import { useSidebar } from "@/contexts"
import { URGENCY_COLORS } from "./config"
import type { UrgencyLevel } from "./types"

/** Track item position for collapsed urgency strip */
export function useUrgencyTracking(
  itemRef: RefObject<HTMLAnchorElement | null>,
  streamId: string,
  urgency: UrgencyLevel,
  scrollContainerRef: RefObject<HTMLDivElement | null> | undefined
) {
  const { setUrgencyBlock, sidebarHeight, scrollContainerOffset, scrollVersion } = useSidebar()

  useLayoutEffect(() => {
    const el = itemRef.current
    const container = scrollContainerRef?.current
    if (!el || !container || sidebarHeight === 0) return

    if (urgency === "quiet") {
      setUrgencyBlock(streamId, null)
      return
    }

    // Measure against the scroll viewport instead of `offsetTop`. Each row is
    // wrapped in a positioned `.group` ancestor, which makes it the row's
    // offsetParent — so `offsetTop` is ~0 for every item and would stack all
    // blocks at the same spot. getBoundingClientRect is offsetParent-independent
    // and reflects the live scroll position, keeping the glow flush with its row
    // as the list scrolls (re-runs via `scrollVersion`).
    const viewport = container.closest("[data-radix-scroll-area-viewport]") ?? container
    const viewportTop = viewport.getBoundingClientRect().top
    const itemRect = el.getBoundingClientRect()

    const position = (scrollContainerOffset + (itemRect.top - viewportTop)) / sidebarHeight
    const height = itemRect.height / sidebarHeight

    setUrgencyBlock(streamId, {
      position,
      height,
      color: URGENCY_COLORS[urgency],
    })

    return () => setUrgencyBlock(streamId, null)
  }, [
    streamId,
    urgency,
    scrollContainerRef,
    sidebarHeight,
    scrollContainerOffset,
    scrollVersion,
    setUrgencyBlock,
    itemRef,
  ])
}
