import { useEffect, useRef } from "react"

interface UseScrollToElementOptions {
  /** Whether scrolling is enabled (e.g., wait for loading to complete) */
  enabled?: boolean
  /** Selector to find the element (alternative to ref) */
  selector?: string
  /** Scroll behavior */
  behavior?: ScrollBehavior
  /** Block alignment */
  block?: ScrollLogicalPosition
  /** Reset the scroll flag when this value changes */
  resetKey?: string
}

/**
 * Hook to scroll to an element once when conditions are met.
 *
 * Can be used with either a ref or a CSS selector:
 * - Ref: Pass a ref to the returned value and it will scroll when enabled
 * - Selector: Pass a selector in options to find and scroll to an element
 *
 * The scroll only happens once per resetKey value.
 */
export function useScrollToElement(options: UseScrollToElementOptions = {}) {
  const { enabled = true, selector, behavior = "smooth", block = "center", resetKey } = options

  const hasScrolled = useRef(false)
  const elementRef = useRef<HTMLElement>(null)

  useEffect(() => {
    hasScrolled.current = false
  }, [resetKey])

  useEffect(() => {
    if (!enabled || hasScrolled.current) return

    const element = selector ? document.querySelector(selector) : elementRef.current

    if (element) {
      element.scrollIntoView({ behavior, block })
      hasScrolled.current = true
    }
  }, [enabled, selector, behavior, block])

  return elementRef
}
