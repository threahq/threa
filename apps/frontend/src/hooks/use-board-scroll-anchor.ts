import { useEffect, useRef } from "react"

/** Below this scrollTop the anchor is disabled, so prepended cards flow in at the
 *  top (the pill-click reveal) instead of being held off-screen above the fold. */
const ANCHOR_DISABLE_PX = 4
/** Sub-pixel layout jitter shouldn't trigger a scroll correction. */
const MIN_COMPENSATION_PX = 0.5

/** Attribute carrying a card's conversation id, read to re-find the anchor card. */
export const BOARD_CARD_ATTR = "data-board-card"

interface Anchor {
  id: string
  /** The card's top offset within the viewport at the moment it was measured. */
  offset: number
}

/** The topmost card still touching the viewport, and its offset within it. */
function measureAnchor(viewport: HTMLElement): Anchor | null {
  const cards = viewport.querySelectorAll<HTMLElement>(`[${BOARD_CARD_ATTR}]`)
  const viewportTop = viewport.getBoundingClientRect().top
  for (const card of cards) {
    const top = card.getBoundingClientRect().top - viewportTop
    if (top + card.offsetHeight > 0) {
      const id = card.getAttribute(BOARD_CARD_ATTR)
      return id ? { id, offset: top } : null
    }
  }
  return null
}

/**
 * Formalize INV-61 for the top-anchored board feed: the topmost visible card
 * keeps its exact screen offset across any mutation. The hard case is async
 * reflow — avatars, link previews and images *above* the viewport loading after
 * the initial layout and growing the region — which would push the card the
 * viewer is reading downward. A `ResizeObserver` on the content catches every
 * such growth (the timeline gets the same guarantee from `virtua`'s `shift`; a
 * non-virtualized board hand-rolls it) and re-pins the anchor card by adding the
 * above-anchor height delta to `scrollTop`.
 *
 * Disabled near the top so a pill-click reveal (scroll to top, then commit) lets
 * the new cards flow in rather than holding the old first card in place.
 */
export function useBoardScrollAnchor(viewport: HTMLElement | null): void {
  const anchorRef = useRef<Anchor | null>(null)

  useEffect(() => {
    if (!viewport) return

    // Re-measure the anchor on every user scroll; our own corrections write
    // scrollTop and re-measure to the same offset, so they don't drift it.
    const onScroll = () => {
      anchorRef.current = measureAnchor(viewport)
    }
    onScroll()
    viewport.addEventListener("scroll", onScroll, { passive: true })

    const content = viewport.firstElementChild
    const observer = new ResizeObserver(() => {
      if (viewport.scrollTop <= ANCHOR_DISABLE_PX) return
      const anchor = anchorRef.current
      if (!anchor) return
      const card = viewport.querySelector<HTMLElement>(`[${BOARD_CARD_ATTR}="${CSS.escape(anchor.id)}"]`)
      if (!card) return
      const top = card.getBoundingClientRect().top - viewport.getBoundingClientRect().top
      const delta = top - anchor.offset
      if (Math.abs(delta) > MIN_COMPENSATION_PX) viewport.scrollTop += delta
    })
    if (content) observer.observe(content)

    return () => {
      viewport.removeEventListener("scroll", onScroll)
      observer.disconnect()
    }
  }, [viewport])
}
