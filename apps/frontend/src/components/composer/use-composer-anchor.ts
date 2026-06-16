import { useCallback, useLayoutEffect, useRef, useState } from "react"

type Measurable = { getBoundingClientRect: () => DOMRect }

/**
 * Anchor a composer-toolbar popover (drafts, scheduled) ABOVE the whole
 * composer instead of over the editor — while keeping its horizontal position
 * matched to the trigger button (its "outside"/fullscreen location).
 *
 * The picker triggers live in the composer's bottom action bar, near the right
 * edge. A default `side="top"` popover anchored to the trigger opens upward and
 * paints over the text the user just typed. Anchoring to the composer pill
 * (`[data-composer-pill]`, stamped by `FloatingComposerShell`) clears the editor
 * but, with `align="end"`, snaps the popover to the composer's far-right edge
 * rather than to the trigger.
 *
 * So the returned anchor is a virtual element that composes both: horizontal
 * extent (left + width) from the trigger, vertical position (top) from the pill.
 * With `align="end" side="top"` the popover's bottom sits at the composer's top
 * edge and its right edge lines up with the trigger — the same horizontal spot
 * it occupies when trigger-anchored, just lifted to clear the editor. The object
 * is stable; floating-ui re-reads `getBoundingClientRect` on scroll/resize, so it
 * always reflects live layout.
 *
 * Two cases fall back to default trigger-relative anchoring (return null):
 *   - No pill ancestor — the expanded fullscreen FAB drawer isn't wrapped in a
 *     `FloatingComposerShell`.
 *   - The composer is mobile-fullscreen (`[data-composer-expanded]`, the 75dvh
 *     mode). It nearly fills the viewport, so anchoring above its top edge
 *     pushes the popover off-screen; the trigger keeps it in view.
 *
 * Resolution re-runs each time the popover opens (passed as `open`) so toggling
 * mobile fullscreen between opens is reflected — the trigger button itself stays
 * mounted across that toggle, so a one-shot ref-callback resolve would go stale.
 */
export function useComposerAnchor(open: boolean) {
  const triggerRef = useRef<HTMLElement | null>(null)
  const pillRef = useRef<HTMLElement | null>(null)
  const [anchored, setAnchored] = useState(false)

  const resolve = useCallback(() => {
    const trigger = triggerRef.current
    if (!trigger || trigger.closest("[data-composer-expanded]")) {
      pillRef.current = null
      setAnchored(false)
      return
    }
    const pill = trigger.closest<HTMLElement>("[data-composer-pill]")
    pillRef.current = pill
    setAnchored(pill != null)
  }, [])

  // Resolve at mount so the common (compact) case is anchored before the first
  // open — no reposition flicker.
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
      const trigger = triggerRef.current?.getBoundingClientRect()
      const pill = pillRef.current?.getBoundingClientRect()
      const left = trigger?.left ?? pill?.left ?? 0
      const width = trigger?.width ?? 0
      const top = pill?.top ?? trigger?.top ?? 0
      return new DOMRect(left, top, width, 0)
    },
  })

  return { setTriggerRef, anchor: anchored ? virtualRef.current : null }
}
