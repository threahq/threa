import { useEffect, useRef } from "react"

/** Focus a contentEditable element with the cursor placed at the end of its content. */
export function focusAtEnd(el: HTMLElement) {
  el.focus()
  const sel = window.getSelection()
  if (!sel) return

  // Walk to the deepest last node so the cursor lands inside the last
  // paragraph, not after it (which would make ProseMirror insert a newline).
  let node: Node = el
  while (node.lastChild) {
    node = node.lastChild
  }
  const offset = node.nodeType === Node.TEXT_NODE ? (node.textContent?.length ?? 0) : 0
  sel.collapse(node, offset)
}

/**
 * Rendered AND within the visual viewport. The board's main zone hosts one
 * composer per open card, so "last in the zone" alone would hand the keystroke
 * to whichever card sits lowest in the DOM — scroll-jumping the feed to a card
 * the user can't see.
 */
function isOnScreen(element: HTMLElement): boolean {
  if (element.getClientRects().length === 0) return false
  const rect = element.getBoundingClientRect()
  const width = window.visualViewport?.width ?? window.innerWidth
  const height = window.visualViewport?.height ?? window.innerHeight
  return rect.bottom > 0 && rect.right > 0 && rect.top < height && rect.left < width
}

/**
 * Last on-screen composer editor in the zone, skipping inline-edit editors.
 * Shared with the agent session card's Redirect action, which needs to know
 * whether the surface has a composer at all before promising the user their
 * message will reach the running session.
 */
export function findVisibleZoneEditor(zone: HTMLElement | null): HTMLElement | null {
  if (!zone) return null
  return Array.from(zone.querySelectorAll<HTMLElement>('[contenteditable="true"]'))
    .filter((element) => !element.closest("[data-inline-edit]"))
    .reduceRight<HTMLElement | null>((match, element) => {
      if (match) return match
      return isOnScreen(element) ? element : null
    }, null)
}

function zoneEditor(zone: "main" | "panel"): HTMLElement | null {
  return findVisibleZoneEditor(document.querySelector<HTMLElement>(`[data-editor-zone="${zone}"]`))
}

/**
 * Enables Slack-like "type anywhere to focus" behavior.
 *
 * Tracks which editor zone (main / panel) was last clicked,
 * then on any printable keypress (when no input is focused)
 * redirects focus to the most relevant contentEditable editor.
 *
 * Priority:
 *  1. Active inline-edit editor (`[data-inline-edit] [contenteditable]`)
 *  2. Last-clicked zone's on-screen editor
 *  3. The other zone's on-screen editor
 */
export function useTypeToFocus() {
  const lastZoneRef = useRef<"main" | "panel">("main")

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      const target = e.target as HTMLElement | null
      const zone = target?.closest<HTMLElement>("[data-editor-zone]")
      if (zone) {
        const value = zone.dataset.editorZone as "main" | "panel"
        if (value === "main" || value === "panel") {
          lastZoneRef.current = value
        }
      }
    }

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key.length !== 1 || e.metaKey || e.ctrlKey || e.altKey) return
      // An IME composition already owns the keystroke, and a handler that
      // called preventDefault has claimed it for something else.
      if (e.isComposing || e.defaultPrevented) return

      const active = document.activeElement
      if (
        active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement ||
        (active instanceof HTMLElement && active.isContentEditable)
      ) {
        return
      }

      // If a dialog is open, focus its editor (full-screen editor) or bail out
      // (delete confirmation, command palette, etc.)
      const openDialog = document.querySelector<HTMLElement>('[role="dialog"][data-state="open"]')
      if (openDialog) {
        const dialogEditor = openDialog.querySelector<HTMLElement>('[contenteditable="true"]')
        if (dialogEditor) {
          focusAtEnd(dialogEditor)
        }
        return
      }

      const inlineEditor = document.querySelector<HTMLElement>("[data-inline-edit] [contenteditable='true']")
      if (inlineEditor) {
        focusAtEnd(inlineEditor)
        return
      }

      // Last-clicked zone first, then the other one — the fallback runs both
      // ways: opening a conversation from a board card leaves the last click in
      // main, and the panel that just opened is where typing must land.
      const other = lastZoneRef.current === "main" ? "panel" : "main"
      const editor = zoneEditor(lastZoneRef.current) ?? zoneEditor(other)
      if (editor) focusAtEnd(editor)
    }

    // Capture phase for clicks so we track zone before any stopPropagation
    document.addEventListener("click", handleClick, true)
    document.addEventListener("keydown", handleKeyDown)

    return () => {
      document.removeEventListener("click", handleClick, true)
      document.removeEventListener("keydown", handleKeyDown)
    }
  }, [])
}
