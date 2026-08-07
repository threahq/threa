import { serializeToMarkdown } from "@threa/prosemirror"
import type { Node as ProseMirrorNode } from "@tiptap/pm/model"

function serializeCut(doc: ProseMirrorNode, from: number, to: number): string | null {
  if (from >= to) return ""
  try {
    const markdown = serializeToMarkdown(doc.cut(from, to).toJSON()).trim()
    return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(markdown) ? null : markdown
  } catch {
    return null
  }
}

function nearestBefore(doc: ProseMirrorNode, to: number, maxChars: number): string {
  let low = 0
  let high = to
  let nearest = ""
  while (low <= high) {
    const from = Math.floor((low + high) / 2)
    const markdown = serializeCut(doc, from, to)
    if (markdown !== null && markdown.length <= maxChars) {
      nearest = markdown
      high = from - 1
    } else {
      low = from + 1
    }
  }
  return nearest
}

function nearestAfter(doc: ProseMirrorNode, from: number, maxChars: number): string {
  let low = from
  let high = doc.content.size
  let nearest = ""
  while (low <= high) {
    const to = Math.floor((low + high) / 2)
    const markdown = serializeCut(doc, from, to)
    if (markdown !== null && markdown.length <= maxChars) {
      nearest = markdown
      low = to + 1
    } else {
      high = to - 1
    }
  }
  return nearest
}

export function getDictationMarkdownContext(
  doc: ProseMirrorNode,
  selection: { from: number; to: number },
  maxChars: number
): { before: string; after: string } {
  return {
    before: nearestBefore(doc, selection.from, maxChars),
    after: nearestAfter(doc, selection.to, maxChars),
  }
}
