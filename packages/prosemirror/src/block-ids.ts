import { ulid } from "ulid"
import type { JSONContent } from "@threahq/types"

export const BLOCK_ID_NODE_TYPES: readonly string[] = [
  "paragraph",
  "heading",
  "bulletList",
  "orderedList",
  "taskList",
  "blockquote",
  "codeBlock",
  "table",
  "horizontalRule",
  "agentBlock",
  "quoteReply",
  "sharedMessage",
]

const BLOCK_ID_TYPE_SET: ReadonlySet<string> = new Set(BLOCK_ID_NODE_TYPES)

export function ensureBlockIds(doc: JSONContent): JSONContent {
  return assignBlockIds(doc, new Set())
}

// Ids are unique within a document: a copied or split block that brought its
// id along is minted a fresh one, so an anchor never resolves to two blocks.
function assignBlockIds(doc: JSONContent, seen: Set<string>): JSONContent {
  const current = doc.attrs?.blockId
  const needsId = BLOCK_ID_TYPE_SET.has(doc.type ?? "") && (typeof current !== "string" || seen.has(current))
  const blockId = needsId ? `blk_${ulid()}` : current
  if (typeof blockId === "string") seen.add(blockId)

  let content = doc.content
  if (doc.content) {
    const children = doc.content.map((child) => assignBlockIds(child, seen))
    if (children.some((child, index) => child !== doc.content![index])) content = children
  }

  if (!needsId && content === doc.content) return doc

  return {
    ...doc,
    ...(needsId ? { attrs: { ...doc.attrs, blockId } } : {}),
    ...(content ? { content } : {}),
  }
}
