import { useLayoutEffect, useState, type RefObject } from "react"

/**
 * Observed content width of an element, for container-driven layout decisions.
 * Viewport breakpoints (`useIsMobile`) can't see container width — a composer
 * in a 320px side panel needs to fold its toolbar even on a huge screen, and a
 * wide composer on a small viewport should stay roomy.
 *
 * The first measurement is taken synchronously in a layout effect (before
 * paint) so width-driven layout doesn't flash its `width === 0` fallback for a
 * frame on mount. Returns 0 only until that first measurement runs.
 */
export function useElementWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    // Synchronous initial read so the first painted frame already reflects the
    // real width (the ResizeObserver callback below only fires on later changes).
    setWidth(el.clientWidth)
    const observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1]
      setWidth(Math.round(entry.contentRect.width))
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref])

  return width
}
