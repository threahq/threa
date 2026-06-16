import { useCallback, useLayoutEffect, useRef, useState } from "react"

/**
 * Anchor a composer-toolbar popover (drafts, scheduled) ABOVE the whole
 * composer instead of over the editor.
 *
 * The picker triggers live in the composer's bottom action bar. A default
 * `side="top"` popover anchors to the trigger button, so it opens upward and
 * paints over the text the user just typed. Anchoring to the composer pill
 * (`[data-composer-pill]`, stamped by `FloatingComposerShell`) instead puts the
 * popover's bottom edge at the composer's top edge, clearing the editor
 * entirely.
 *
 * Two cases fall back to default trigger-relative anchoring (return null):
 *   - No pill ancestor — the expanded fullscreen FAB drawer isn't wrapped in a
 *     `FloatingComposerShell`.
 *   - The composer is mobile-fullscreen (`[data-composer-expanded]`, the 75dvh
 *     mode). It nearly fills the viewport, so anchoring above its top edge
 *     pushes the popover off-screen; the trigger keeps it in view.
 *
 * Resolution re-runs each time the popover opens (passed as `open`) so toggling
 * mobile fullscreen between opens is reflected — the trigger button itself
 * stays mounted across that toggle, so a one-shot ref-callback resolve would go
 * stale.
 */
export function useComposerAnchor(open: boolean) {
  const triggerRef = useRef<HTMLElement | null>(null)
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)

  const resolveAnchor = useCallback((trigger: HTMLElement | null) => {
    if (!trigger || trigger.closest("[data-composer-expanded]")) {
      setAnchor(null)
      return
    }
    setAnchor(trigger.closest<HTMLElement>("[data-composer-pill]"))
  }, [])

  // Resolve at mount so the common (compact) case is anchored before the first
  // open — no reposition flicker.
  const setTriggerRef = useCallback(
    (node: HTMLElement | null) => {
      triggerRef.current = node
      resolveAnchor(node)
    },
    [resolveAnchor]
  )

  // Re-resolve on each open so toggling mobile fullscreen between opens is
  // reflected; the trigger button stays mounted across the toggle.
  useLayoutEffect(() => {
    if (open) resolveAnchor(triggerRef.current)
  }, [open, resolveAnchor])

  return { setTriggerRef, anchor }
}
