import type { Editor } from "@tiptap/core"
import { StreamTypes } from "@threahq/types"
import { classifyDraftLink } from "@/lib/in-app-links"
import { getCachedWorkspaceTables, indexStreams } from "@/stores/workspace-store"

/** Position 0 is before the doc's first node and reads as "no position" to `focus`, so clamp to the first one inside it. */
const focusAt = (editor: Editor, at: number) => editor.commands.focus(Math.max(at, 1))

/**
 * Convert a bare in-app stream/message/conversation URL into an inline chip,
 * replacing the link text. Shared by the clipboard `paste` path, the
 * Gboard/SwiftKey `beforeinput` path, and the drop path so mobile clipboard-bar
 * pastes and dragged links chip the same as a desktop paste. Returns whether a
 * chip was inserted. A conversation link carries no streamId — the node-view
 * resolves it by URL. `at` places the chip at a document position (the drop
 * point) instead of the caret.
 */
export function tryInsertInAppLinkChip(editor: Editor, text: string, at?: number): boolean {
  const ref = classifyDraftLink(text.trim())
  if (!ref || (ref.kind !== "stream" && ref.kind !== "message" && ref.kind !== "conversation")) return false
  // Separate commands, not one chain: `insertInAppLink` reads the caret off the
  // state it was handed, so the move has to commit before it runs.
  if (at !== undefined) focusAt(editor, at)
  editor.commands.insertInAppLink({
    url: ref.url,
    streamId: ref.kind === "conversation" ? null : ref.streamId,
    messageId: ref.kind === "message" ? ref.messageId : null,
  })
  return true
}

/**
 * Inserts a doc chip for a link to an active doc other than `selfDocId`, at `at` or the caret, outside code.
 * The doc is looked up in the workspace store when called, so a doc created a moment ago is recognised.
 */
export function tryInsertDocChip(
  editor: Editor,
  text: string,
  { workspaceId, selfDocId }: { workspaceId: string; selfDocId?: string },
  at?: number
): boolean {
  const ref = classifyDraftLink(text.trim())
  if (ref?.kind !== "stream" || ref.streamId === selfDocId) return false
  const doc = indexStreams(getCachedWorkspaceTables(workspaceId).streams ?? []).get(ref.streamId)
  if (doc?.type !== StreamTypes.DOC || doc.archivedAt) return false
  const $at = at === undefined ? editor.state.selection.$from : editor.state.doc.resolve(at)
  if ($at.parent.type.spec.code) return false
  if (at !== undefined) focusAt(editor, at)
  editor.commands.insertDocEmbed({ docId: doc.id, title: doc.displayName ?? "" })
  return true
}
