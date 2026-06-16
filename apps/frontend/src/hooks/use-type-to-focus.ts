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
 * Enables Slack-like "type anywhere to focus" behavior.
 *
 * Tracks which editor zone (main / panel) was last clicked,
 * then on any printable keypress (when no input is focused)
 * redirects focus to the most relevant contentEditable editor.
 *
 * Priority:
 *  1. Active inline-edit editor (`[data-inline-edit] [contenteditable]`)
 *  2. Last-clicked zone's editor
 *  3. Main zone fallback
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

      const zoneSelector = `[data-editor-zone="${lastZoneRef.current}"] [contenteditable="true"]`
      const zoneEditor = document.querySelector<HTMLElement>(zoneSelector)
      if (zoneEditor) {
        focusAtEnd(zoneEditor)
        return
      }

      if (lastZoneRef.current !== "main") {
        const mainEditor = document.querySelector<HTMLElement>('[data-editor-zone="main"] [contenteditable="true"]')
        if (mainEditor) {
          focusAtEnd(mainEditor)
        }
      }
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
