import { useEffect, useRef } from "react"
import type { RefObject } from "react"
import { attachScrollGestureDirection } from "./scroll-gesture-direction"

interface Options {
  /** The collapsed card's "N older messages" seam row. */
  seamRef: RefObject<HTMLElement | null>
  /** This card's root element — the gesture target, so a flick over a sibling
   *  card never pages this one. */
  cardRef: RefObject<HTMLElement | null>
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
 * would chain through the whole hidden middle in one frame.
 *
 * Pacing is per intersection round-trip, not per event: a trackpad flick emits
 * ~60-120 wheel events a second while IntersectionObserver only reports the seam
 * leaving asynchronously, so "one page per event" dumps the middle anyway. After
 * a reveal the gate closes and the seam is re-observed — a freshly observed target
 * always gets an initial entry delivered after layout, so the next page waits on
 * the truth (seam pushed off screen, or still visible) rather than on event rate.
 */
export function useBoardGapAutoReveal({ seamRef, cardRef, scrollerRef, enabled, onReveal }: Options): void {
  // Held in refs so a re-render (every reveal changes the card) doesn't tear the
  // observer and listeners down and back up mid-gesture.
  const onRevealRef = useRef(onReveal)
  onRevealRef.current = onReveal
  const intersectingRef = useRef(false)

  useEffect(() => {
    const seam = seamRef.current
    const card = cardRef.current
    const scroller = scrollerRef?.current
    if (!enabled || !seam || !card || !scroller || typeof IntersectionObserver === "undefined") return

    intersectingRef.current = false
    const observer = new IntersectionObserver(
      ([entry]) => {
        intersectingRef.current = entry.isIntersecting
      },
      { root: scroller }
    )
    observer.observe(seam)

    const detachGestures = attachScrollGestureDirection(card, {
      onUp: () => {
        if (!intersectingRef.current) return
        intersectingRef.current = false
        onRevealRef.current()
        observer.unobserve(seam)
        observer.observe(seam)
      },
    })
    return () => {
      observer.disconnect()
      detachGestures()
    }
  }, [enabled, seamRef, cardRef, scrollerRef])
}
