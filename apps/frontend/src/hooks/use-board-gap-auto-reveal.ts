import { useEffect, useRef } from "react"
import type { RefObject } from "react"
import { attachScrollGestureDirection } from "./scroll-gesture-direction"

interface Options {
  /** The collapsed card's "N older messages" seam row. */
  seamRef: RefObject<HTMLElement | null>
  /** The board's owned scroll viewport. Absent off the board page (tests, jsdom). */
  scrollerRef?: RefObject<HTMLDivElement | null>
  enabled: boolean
  onReveal: () => void
}

/**
 * Turns scrolling up onto a collapsed board card's seam into a page of older
 * messages, the way reading up past the timeline's unread divider keeps going.
 *
 * A reveal needs BOTH the seam on screen and a fresh upward gesture event — never
 * intersection alone. That is the cascade guard: a revealed page shorter than the
 * viewport leaves the seam still intersecting, and an intersection-driven trigger
 * would chain through the whole hidden middle in one frame. One gesture event
 * (one wheel tick, one touchmove) buys at most one page, so the reader's own
 * scrolling paces the walk backward.
 */
export function useBoardGapAutoReveal({ seamRef, scrollerRef, enabled, onReveal }: Options): void {
  // Held in refs so a re-render (every reveal changes the card) doesn't tear the
  // observer and listeners down and back up mid-gesture.
  const onRevealRef = useRef(onReveal)
  onRevealRef.current = onReveal
  const intersectingRef = useRef(false)

  useEffect(() => {
    const seam = seamRef.current
    const scroller = scrollerRef?.current
    if (!enabled || !seam || !scroller || typeof IntersectionObserver === "undefined") return

    intersectingRef.current = false
    const observer = new IntersectionObserver(
      ([entry]) => {
        intersectingRef.current = entry.isIntersecting
      },
      { root: scroller }
    )
    observer.observe(seam)

    const detachGestures = attachScrollGestureDirection(scroller, {
      onUp: () => {
        if (intersectingRef.current) onRevealRef.current()
      },
    })
    return () => {
      observer.disconnect()
      detachGestures()
    }
  }, [enabled, seamRef, scrollerRef])
}
