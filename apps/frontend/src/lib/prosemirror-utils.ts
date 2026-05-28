import type { JSONContent } from "@threa/types"

/**
 * Canonical empty ProseMirror document — one empty paragraph, which is the
 * shape TipTap settles on after clearing. Module-level so the reference is
 * stable across renders (no `useMemo` needed in callers). Also the natural
 * pair for `isEmptyContent`, which would return `true` for this value.
 *
 * Do not mutate.
 */
export const EMPTY_DOC: JSONContent = { type: "doc", content: [{ type: "paragraph" }] }

/**
 * Check if ProseMirror JSONContent is effectively empty (only contains empty paragraphs).
 *
 * Used to determine whether a draft message should be deleted or shown in the drafts view.
 */
export function isEmptyContent(contentJson: JSONContent | undefined): boolean {
  if (!contentJson) return true
  if (!contentJson.content) return true
  return contentJson.content.every((node) => node.type === "paragraph" && (!node.content || node.content.length === 0))
}

/**
 * Block-level atom node types — these can't host a cursor inside themselves
 * and need a trailing paragraph to give the user a reachable text position.
 * Inline atoms (e.g. `attachmentReference`, `mention`) live inside paragraphs
 * and don't have this problem.
 */
const BLOCK_ATOM_TYPES = new Set(["quoteReply", "sharedMessage"])

/**
 * Ensure the doc ends with an empty paragraph when its last child is a
 * block-level atom. Without this, ProseMirror's selection lands on a
 * gap-cursor that has no tap target on mobile — the user sees their cursor
 * "stuck" before/inside the atom and can't type anywhere after it. The
 * normalization is a no-op for content that already ends in a paragraph
 * (or any non-atom block).
 *
 * Used when seeding the editor with persisted content (scheduled-message
 * edit, draft restore) so reopening a message that was sent without a
 * trailing paragraph still gives the user somewhere to type.
 */
export function ensureTrailingParagraph(contentJson: JSONContent): JSONContent {
  const blocks = contentJson.content
  if (!blocks || blocks.length === 0) return contentJson
  const last = blocks[blocks.length - 1]
  if (!last || !BLOCK_ATOM_TYPES.has(last.type ?? "")) return contentJson
  return { ...contentJson, content: [...blocks, { type: "paragraph" }] }
}
