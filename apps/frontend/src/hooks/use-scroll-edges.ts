import { useLayoutEffect, useState } from "react"

export interface ScrollEdges {
  /** Content is scrolled past the top. */
  above: boolean
  /** Content continues below the visible end. */
  below: boolean
}

/** Which edges of a scrolling element have content past them, tracked through scrolls, resizes and child changes. */
export function useScrollEdges(element: HTMLElement | null): ScrollEdges {
  const [edges, setEdges] = useState<ScrollEdges>({ above: false, below: false })
  useLayoutEffect(() => {
    if (!element) return
    const measure = () => {
      const above = element.scrollTop > 1
      const below = element.scrollTop + element.clientHeight < element.scrollHeight - 1
      setEdges((prev) => (prev.above === above && prev.below === below ? prev : { above, below }))
    }
    const resize = new ResizeObserver(measure)
    const observeAll = () => {
      resize.observe(element)
      for (const child of element.children) resize.observe(child)
    }
    const mutation = new MutationObserver(() => {
      observeAll()
      measure()
    })
    observeAll()
    mutation.observe(element, { childList: true })
    element.addEventListener("scroll", measure, { passive: true })
    measure()
    return () => {
      resize.disconnect()
      mutation.disconnect()
      element.removeEventListener("scroll", measure)
    }
  }, [element])
  return edges
}
