import { useCallback, useState } from "react"

/**
 * Anchor a composer-toolbar popover (drafts, scheduled) ABOVE the whole
 * composer instead of over the editor.
 *
 * The picker triggers live in the composer's bottom action bar. A default
 * `side="top"` popover anchors to the trigger button, so it opens upward and
 * paints over the text the user just typed (INV-21 — hints/popovers must not
 * obscure content). Anchoring to the composer pill (`[data-composer-pill]`,
 * stamped by `FloatingComposerShell`) instead puts the popover's bottom edge at
 * the composer's top edge, clearing the editor entirely.
 *
 * `closest()` returns null in the expanded fullscreen layout (the FAB drawer
 * isn't wrapped in a `FloatingComposerShell`), so those triggers keep default
 * trigger-relative anchoring — render the `<PopoverAnchor>` only when `anchor`
 * is set.
 */
export function useComposerAnchor() {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)

  const setTriggerRef = useCallback((node: HTMLElement | null) => {
    setAnchor(node ? node.closest<HTMLElement>("[data-composer-pill]") : null)
  }, [])

  return { setTriggerRef, anchor }
}
