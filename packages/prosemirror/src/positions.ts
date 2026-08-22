/**
 * ProseMirror document positions computed straight from the JSON tree, with no
 * `Schema` and no `prosemirror-model` dependency — the backend, the workers and
 * the editor all need the same numbers, and only the editor ships a schema.
 *
 * The sizing rules are ProseMirror's own: a text node is `text.length`, a
 * leaf/atom node is `1`, any other node is `2 + sum(children)`. A range of
 * positions therefore means the same thing here as it does inside a live
 * editor; `prosemirror-positions.contract.test.ts` in the frontend proves the
 * two agree against the real tiptap schema.
 */

import type { JSONContent } from "@threa/types"

/**
 * Node types with no children — size 1 (or `text.length` for text). Kept in
 * sync with the tiptap schema by the frontend contract test, which fails when
 * an extension adds or changes a leaf node.
 *
 * `command` is the API-only alias for the editor's `slashCommand` node: the
 * public API accepts it and the markdown serializer treats both as atoms, so a
 * stored document can carry either name.
 */
export const LEAF_NODE_TYPES: ReadonlySet<string> = new Set([
  "text",
  "hardBreak",
  "horizontalRule",
  "mention",
  "channelLink",
  "slashCommand",
  "command",
  "emoji",
  "attachmentReference",
  "memoEmbed",
  "giphyEmbed",
  "inAppLink",
  "quoteReply",
  "sharedMessage",
])

/** Node types that hold children — size `2 + sum(children)`, even when empty. */
export const CONTAINER_NODE_TYPES: ReadonlySet<string> = new Set([
  "doc",
  "paragraph",
  "heading",
  "codeBlock",
  "blockquote",
  "agentBlock",
  "bulletList",
  "orderedList",
  "listItem",
  "table",
  "tableRow",
  "tableHeader",
  "tableCell",
])

export class UnknownNodeTypeError extends Error {
  constructor(public readonly nodeType: string) {
    super(`Cannot size unknown ProseMirror node type "${nodeType}"`)
    this.name = "UnknownNodeTypeError"
  }
}

/** ProseMirror `Node.nodeSize` for a JSON node. */
export function nodeSize(node: JSONContent): number {
  if (node.type === "text") return node.text?.length ?? 0
  const type = node.type ?? ""
  if (LEAF_NODE_TYPES.has(type)) return 1
  if (CONTAINER_NODE_TYPES.has(type) || node.content) return 2 + contentSize(node)
  throw new UnknownNodeTypeError(type)
}

/** ProseMirror `Node.content.size` for a JSON node — the doc's position space. */
export function docContentSize(doc: JSONContent): number {
  return contentSize(doc)
}

function contentSize(node: JSONContent): number {
  let size = 0
  for (const child of node.content ?? []) {
    size += nodeSize(child)
  }
  return size
}
