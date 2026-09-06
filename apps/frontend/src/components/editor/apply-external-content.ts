import type { JSONContent } from "@threahq/types"

/**
 * The minimal editor surface the external-content sync touches. Kept structural
 * so the guard can be unit-tested with a fake whose `setContent` throws, without
 * standing up a real TipTap instance (the rest of the suite mocks the editor).
 */
export interface ExternalContentEditor {
  isFocused: boolean
  commands: {
    setContent: (content: JSONContent) => void
    focus: (position?: "end") => void
  }
}

/**
 * Apply an externally-supplied value (e.g. a restored draft body) to the editor,
 * guarding the `isInternalUpdate` flag so a throw can NEVER strand it `true`.
 *
 * Stranding it true is the load-bearing failure: it both freezes the editor on
 * the stale doc AND turns every later `onUpdate` into a no-op, so the composer
 * goes dead — typing isn't even persisted — until a remount (the "draft restore
 * did nothing until I refreshed" report). The `finally` makes that impossible.
 *
 * Returns whether the content was applied; the caller retries on `false` so the
 * (correct) source content still reaches the editor rather than leaving a blank
 * composer over a draft the restore already checked out of the stash.
 */
export function applyExternalEditorContent(
  editor: ExternalContentEditor,
  editableValue: JSONContent,
  isInternalUpdate: { current: boolean }
): boolean {
  const hadFocus = editor.isFocused
  let applied = false
  isInternalUpdate.current = true
  try {
    editor.commands.setContent(editableValue)
    applied = true
  } catch (err) {
    console.error("Editor failed to apply external content", err)
  } finally {
    isInternalUpdate.current = false
  }

  // Focus follows the content: a focused editor whose doc was just replaced
  // (draft restore, send-clear) gets the caret at the END of the new body —
  // `setContent` otherwise leaves the selection at the start, stranding the
  // caret before the text the user just restored. This also covers mobile
  // browsers dropping focus when contenteditable content is replaced (the
  // refocus keeps the virtual keyboard open). Only when we actually applied.
  if (applied && hadFocus) {
    editor.commands.focus("end")
  }

  return applied
}
