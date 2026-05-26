/**
 * Markdown table input rule.
 *
 * When the user types a GFM table pattern as plain paragraphs (header row,
 * separator row, optional data rows) and presses Enter, the trailing pipe-row
 * paragraphs are replaced by a real ProseMirror table node. Other markdown
 * patterns (bold, italic, code fences) already have inline / Enter input
 * rules; tables span multiple paragraphs so we need a dedicated handler.
 *
 * Trigger: Enter at the end of a top-level paragraph whose text contains a
 * pipe, when walking backward through contiguous pipe-containing siblings
 * produces a string that `parseMarkdown` interprets as a single table block.
 */
import { Extension, type Editor } from "@tiptap/core"
import { TextSelection } from "@tiptap/pm/state"
import { Fragment } from "@tiptap/pm/model"
import { parseMarkdown } from "./editor-markdown"

function convertTrailingTable(editor: Editor): boolean {
  const { state } = editor
  const { selection } = state

  if (!selection.empty) return false
  if (
    editor.isActive("codeBlock") ||
    editor.isActive("table") ||
    editor.isActive("blockquote") ||
    editor.isActive("listItem")
  ) {
    return false
  }

  const $from = selection.$from
  if ($from.parent.type.name !== "paragraph") return false
  if ($from.parentOffset !== $from.parent.content.size) return false
  // Only handle top-level paragraphs (direct children of the doc) so we don't
  // accidentally tear apart structured containers (blockquote, list item, …).
  if ($from.depth !== 1) return false

  const doc = state.doc
  const currentIndex = $from.index(0)

  const indices: number[] = []
  for (let i = currentIndex; i >= 0; i--) {
    const child = doc.child(i)
    if (child.type.name !== "paragraph") break
    const text = child.textContent
    if (!text.includes("|")) {
      if (i === currentIndex) return false
      break
    }
    indices.unshift(i)
  }

  if (indices.length < 2) return false

  const lines = indices.map((i) => doc.child(i).textContent)
  const parsed = parseMarkdown(lines.join("\n"))
  const blocks = parsed.content
  if (!blocks || blocks.length !== 1 || blocks[0].type !== "table") return false

  let pos = 0
  let firstPos = -1
  let lastEnd = -1
  const firstIdx = indices[0]
  const lastIdx = indices[indices.length - 1]
  for (let i = 0; i <= lastIdx; i++) {
    const child = doc.child(i)
    if (i === firstIdx) firstPos = pos
    pos += child.nodeSize
    if (i === lastIdx) lastEnd = pos
  }
  if (firstPos < 0 || lastEnd < 0) return false

  const tableNode = state.schema.nodeFromJSON(blocks[0])
  if (!tableNode) return false

  const paragraphType = state.schema.nodes.paragraph
  const emptyPara = paragraphType.create()
  const fragment = Fragment.fromArray([tableNode, emptyPara])

  const tr = state.tr.replaceWith(firstPos, lastEnd, fragment)
  // Land the cursor in the trailing empty paragraph so the user can keep
  // typing below the new table — matches what plain Enter would have done
  // had we not intercepted it.
  const trailingParaPos = firstPos + tableNode.nodeSize + 1
  tr.setSelection(TextSelection.create(tr.doc, trailingParaPos))
  editor.view.dispatch(tr)
  return true
}

export const MarkdownTableInputRule = Extension.create({
  name: "markdownTableInputRule",
  // Higher than EditorBehaviors (priority 1000) so we get first crack at
  // Enter before its splitBlock fallback runs.
  priority: 1100,

  addKeyboardShortcuts() {
    return {
      Enter: () => convertTrailingTable(this.editor),
    }
  },
})
