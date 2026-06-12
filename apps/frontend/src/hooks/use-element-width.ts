import { useEffect, useState, type RefObject } from "react"

/**
 * Observed width of an element, for container-driven layout decisions.
 * Viewport breakpoints (useIsMobile) can't see panel widths — a composer in a
 * 320px side panel needs to squash its toolbar even on a huge screen.
 * Returns 0 until the first measurement.
 */
export function useElementWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1]
      setWidth(Math.round(entry.contentRect.width))
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref])

  return width
}
