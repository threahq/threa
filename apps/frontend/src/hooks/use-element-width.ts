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
    // Measure padding-box width (clientWidth) on both the initial read and the
    // observer so the value never jumps box models — contentRect is content-box
    // while clientWidth includes padding, and mixing them would shift by the
    // padding on the first resize. The synchronous initial read keeps the first
    // painted frame at the real width (the observer only fires on later changes).
    const measure = (target: HTMLElement) => setWidth(target.clientWidth)
    measure(el)
    const observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1]
      measure(entry.target as HTMLElement)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref])

  return width
}
