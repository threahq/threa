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
  for (let from = 0; from < to; from++) {
    const markdown = serializeCut(doc, from, to)
    if (markdown !== null && markdown.length <= maxChars) return markdown
  }
  return ""
}

function nearestAfter(doc: ProseMirrorNode, from: number, maxChars: number): string {
  for (let to = doc.content.size; to > from; to--) {
    const markdown = serializeCut(doc, from, to)
    if (markdown !== null && markdown.length <= maxChars) return markdown
  }
  return ""
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
