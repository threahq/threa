interface Handlers {
  /** The reader is scrolling content UP (toward older): wheel deltaY < 0, or a
   *  finger moving DOWN the screen. */
  onUp?: () => void
  onDown?: () => void
}

/**
 * The one place that reads a scroll gesture's direction off a scroller. Wheel is
 * trivial; touch is not, and both the gap auto-reveal and the reveal anchor need
 * exactly the same reading, so it lives here rather than in each hook (INV-35/37).
 *
 * `lastTouchY` starts as `null`, not 0: a listener attached mid-drag (the anchor
 * arms while the finger is already down) would read the first touchmove against a
 * phantom origin at the top of the screen and call ANY move "scrolling up".
 * Direction is unknown until a touchstart records an origin — neither handler fires.
 */
export function attachScrollGestureDirection(scroller: HTMLElement, { onUp, onDown }: Handlers): () => void {
  let lastTouchY: number | null = null

  const onTouchStart = (e: TouchEvent) => {
    lastTouchY = e.touches[0]?.clientY ?? null
  }
  const onTouchMove = (e: TouchEvent) => {
    const y = e.touches[0]?.clientY
    if (y === undefined) return
    const origin = lastTouchY
    lastTouchY = y
    if (origin === null) return
    if (y > origin) onUp?.()
    else onDown?.()
  }
  const onWheel = (e: WheelEvent) => {
    if (e.deltaY < 0) onUp?.()
    else onDown?.()
  }

  scroller.addEventListener("wheel", onWheel, { passive: true })
  scroller.addEventListener("touchstart", onTouchStart, { passive: true })
  scroller.addEventListener("touchmove", onTouchMove, { passive: true })
  return () => {
    scroller.removeEventListener("wheel", onWheel)
    scroller.removeEventListener("touchstart", onTouchStart)
    scroller.removeEventListener("touchmove", onTouchMove)
  }
}
