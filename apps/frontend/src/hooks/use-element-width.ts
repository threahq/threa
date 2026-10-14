import { useLayoutEffect, useState, type RefCallback, type RefObject } from "react"
import { paneLanding } from "@/components/panes/pane-glide"

/**
 * Feeds `element`'s padding-box width (`clientWidth`) to `onWidth` now and on every resize, except
 * while a glide sizes its pane: the box changes every frame then, so the width it lands at is the one fed.
 */
function observeWidth(element: HTMLElement, onWidth: (width: number) => void): () => void {
  let held = false
  let live = true
  const measure = () => {
    if (live) onWidth(element.clientWidth)
  }
  measure()
  const observer = new ResizeObserver(() => {
    if (held) return
    const landing = paneLanding(element)
    if (!landing) return measure()
    held = true
    void landing.then(() => {
      held = false
      measure()
    })
  })
  observer.observe(element)
  return () => {
    live = false
    observer.disconnect()
  }
}

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
    // Padding-box width (clientWidth) on both the initial read and the observer
    // so the value never jumps box models: contentRect is content-box, and
    // mixing them would shift by the padding on the first resize. The
    // synchronous initial read keeps the first painted frame at the real width.
    return observeWidth(el, setWidth)
  }, [ref])

  return width
}

/**
 * {@link useElementWidth} for an element that remounts as the layout changes:
 * the width follows whichever element holds the returned ref.
 */
export function useMeasuredWidth<T extends HTMLElement>(): [RefCallback<T>, number] {
  const [element, setElement] = useState<T | null>(null)
  const [width, setWidth] = useState(0)

  useLayoutEffect(() => {
    if (!element) return
    return observeWidth(element, setWidth)
  }, [element])

  return [setElement, width]
}
