import { useCallback, useLayoutEffect, useRef, useState } from "react"

type Measurable = { getBoundingClientRect: () => DOMRect }

/**
 * Anchor a composer-toolbar popover (drafts, scheduled) so its right edge lines
 * up with the composer's right edge and it clears the editor — the same
 * horizontal position whether the composer is minimized or fullscreen.
 *
 * The picker triggers live in the composer's bottom action bar. A default
 * `side="top"` popover anchored to the trigger opens upward over the editor and
 * sits wherever the (mid-bar) trigger button is, not flush with the composer.
 * Instead we anchor to a virtual element built from the composer card
 * (`[data-composer-card]`, the rounded input box):
 *   - X: spans the card, so with `align="end"` the popover's right edge matches
 *     the composer's right edge in every layout.
 *   - Y: the card's top edge normally, so the popover's bottom sits at the
 *     composer's top edge (clearing the editor). When the composer is
 *     mobile-fullscreen (`[data-composer-expanded]`, the 75dvh mode) it nearly
 *     fills the viewport, so anchoring above its top would push the popover
 *     off-screen — there we use the trigger's top instead, keeping it on screen
 *     while X stays composer-aligned.
 *
 * The virtual element is stable; floating-ui re-reads `getBoundingClientRect` on
 * scroll/resize, so it always reflects live layout.
 *
 * Returns null (default trigger-relative anchoring) when there's no card
 * ancestor — the expanded fullscreen FAB drawer isn't an inline composer.
 *
 * Resolution re-runs each time the popover opens (passed as `open`) so toggling
 * mobile fullscreen between opens is reflected; the trigger button stays mounted
 * across that toggle, so a one-shot ref-callback resolve would go stale.
 */
export function useComposerAnchor(open: boolean) {
  const triggerRef = useRef<HTMLElement | null>(null)
  const cardRef = useRef<HTMLElement | null>(null)
  const expandedRef = useRef(false)
  const [anchored, setAnchored] = useState(false)

  const resolve = useCallback(() => {
    const trigger = triggerRef.current
    const card = trigger?.closest<HTMLElement>("[data-composer-card]") ?? null
    cardRef.current = card
    expandedRef.current = trigger?.closest("[data-composer-expanded]") != null
    setAnchored(card != null)
  }, [])

  // Resolve at mount so the common case is anchored before the first open — no
  // reposition flicker.
  const setTriggerRef = useCallback(
    (node: HTMLElement | null) => {
      triggerRef.current = node
      resolve()
    },
    [resolve]
  )

  // Re-resolve on each open so toggling mobile fullscreen between opens is
  // reflected; the trigger button stays mounted across the toggle.
  useLayoutEffect(() => {
    if (open) resolve()
  }, [open, resolve])

  const virtualRef = useRef<Measurable>({
    getBoundingClientRect: () => {
      const card = cardRef.current?.getBoundingClientRect()
      const trigger = triggerRef.current?.getBoundingClientRect()
      if (!card) return trigger ?? new DOMRect()
      const top = expandedRef.current ? (trigger?.top ?? card.top) : card.top
      return new DOMRect(card.left, top, card.width, 0)
    },
  })

  return { setTriggerRef, anchor: anchored ? virtualRef.current : null }
}
