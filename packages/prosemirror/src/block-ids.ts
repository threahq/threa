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

export function newBlockId(): string {
  return `blk_${ulid()}`
}

export function ensureBlockIds(doc: JSONContent): JSONContent {
  let content = doc.content
  if (doc.content) {
    const children = doc.content.map(ensureBlockIds)
    if (children.some((child, index) => child !== doc.content![index])) content = children
  }

  const needsId = BLOCK_ID_TYPE_SET.has(doc.type ?? "") && typeof doc.attrs?.blockId !== "string"
  if (!needsId && content === doc.content) return doc

  return {
    ...doc,
    ...(needsId ? { attrs: { ...doc.attrs, blockId: newBlockId() } } : {}),
    ...(content ? { content } : {}),
  }
}
