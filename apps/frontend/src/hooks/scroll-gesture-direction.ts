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
 * The tracked touch starts as `null`, not 0: a listener attached mid-drag (the
 * anchor arms while the finger is already down) would read the first touchmove
 * against a phantom origin at the top of the screen and call ANY move "scrolling
 * up". Direction is unknown until a touchstart records an origin — neither handler
 * fires.
 *
 * Tracking is BY IDENTIFIER, not by `touches[0]`: with two fingers down, lifting
 * the first promotes the second into slot 0, and comparing its coordinate against
 * the departed finger's last one reads a direction that nobody made — often the
 * opposite one. Adopting the survivor as a fresh origin costs one event of
 * unknown direction and can't misread.
 */
export function attachScrollGestureDirection(scroller: HTMLElement, { onUp, onDown }: Handlers): () => void {
  let tracked: { id: number; y: number } | null = null

  const onTouchStart = (e: TouchEvent) => {
    if (tracked) return
    const touch = e.touches[0]
    if (touch) tracked = { id: touch.identifier, y: touch.clientY }
  }
  const onTouchMove = (e: TouchEvent) => {
    const origin = tracked
    if (!origin) return
    const touches = [...e.touches]
    const same = touches.find((touch) => touch.identifier === origin.id)
    if (!same) {
      // The tracked finger lifted mid-gesture; re-origin on whoever is left.
      const survivor = touches[0]
      tracked = survivor ? { id: survivor.identifier, y: survivor.clientY } : null
      return
    }
    const y = same.clientY
    tracked = { id: origin.id, y }
    if (y > origin.y) onUp?.()
    else onDown?.()
  }
  const onTouchEnd = (e: TouchEvent) => {
    const origin = tracked
    if (!origin) return
    if (![...e.touches].some((touch) => touch.identifier === origin.id)) tracked = null
  }
  const onWheel = (e: WheelEvent) => {
    if (e.deltaY < 0) onUp?.()
    else onDown?.()
  }

  scroller.addEventListener("wheel", onWheel, { passive: true })
  scroller.addEventListener("touchstart", onTouchStart, { passive: true })
  scroller.addEventListener("touchmove", onTouchMove, { passive: true })
  scroller.addEventListener("touchend", onTouchEnd, { passive: true })
  scroller.addEventListener("touchcancel", onTouchEnd, { passive: true })
  return () => {
    scroller.removeEventListener("wheel", onWheel)
    scroller.removeEventListener("touchstart", onTouchStart)
    scroller.removeEventListener("touchmove", onTouchMove)
    scroller.removeEventListener("touchend", onTouchEnd)
    scroller.removeEventListener("touchcancel", onTouchEnd)
  }
}
