/**
 * Markdown table input rule.
 *
 * When the user types a GFM table pattern as plain paragraphs (header row,
 * optional separator row, optional data rows) and presses Enter, the trailing
 * pipe-row paragraphs are replaced by a real ProseMirror table node. Other
 * markdown patterns (bold, italic, code fences) already have inline / Enter
 * input rules; tables span multiple paragraphs so we need a dedicated handler.
 *
 * Trigger: Enter at the end of a top-level paragraph whose text contains a
 * pipe, when the trailing contiguous pipe-row paragraphs either parse as a
 * single table (header + separator + ...) or look like a standalone header
 * row that we can promote into a table with one empty body row.
 */
import { Extension, type Editor } from "@tiptap/core"
import type { Node as ProseMirrorNode } from "@tiptap/pm/model"
import { TextSelection } from "@tiptap/pm/state"
import { Fragment } from "@tiptap/pm/model"
import type { JSONContent } from "@threa/types"
import { parseMarkdown } from "./editor-markdown"

type TableConversion = {
  tableJSON: JSONContent
  cursorTarget: "trailingParagraph" | "firstBodyCell"
}

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
  if (indices.length === 0) return false

  const lines = indices.map((i) => doc.child(i).textContent)
  const conversion = buildConversion(lines)
  if (!conversion) return false

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

  const tableNode = state.schema.nodeFromJSON(conversion.tableJSON)
  if (!tableNode) return false

  const paragraphType = state.schema.nodes.paragraph
  const emptyPara = paragraphType.create()
  const fragment = Fragment.fromArray([tableNode, emptyPara])

  const tr = state.tr.replaceWith(firstPos, lastEnd, fragment)
  const cursorPos =
    conversion.cursorTarget === "firstBodyCell"
      ? firstBodyCellTextPos(tableNode, firstPos)
      : firstPos + tableNode.nodeSize + 1
  tr.setSelection(TextSelection.create(tr.doc, cursorPos))
  editor.view.dispatch(tr)
  return true
}

function buildConversion(lines: string[]): TableConversion | null {
  if (lines.length === 0) return null

  // Multi-line pattern: user typed at least header + separator (+ rows).
  // Trust the markdown parser to validate the structure.
  if (lines.length >= 2) {
    const parsed = parseMarkdown(lines.join("\n"))
    const blocks = parsed.content
    if (!blocks || blocks.length !== 1 || blocks[0].type !== "table") return null
    return { tableJSON: blocks[0], cursorTarget: "trailingParagraph" }
  }

  // Single-line pattern: promote a standalone header row into a table with
  // one empty body row so the user can keep typing values immediately.
  // Require outer pipes (`| a | b |`) here — a bare `a | b` is too easily a
  // sentence, and the user can always type the separator row to disambiguate.
  const headerText = lines[0]
  const columnCount = countRowCells(headerText)
  if (!hasOuterPipes(headerText) || columnCount < 2 || isAllSeparator(headerText)) {
    return null
  }
  // Parse header + separator into a real table, then append an empty body row
  // ourselves. Round-tripping the empty row through markdown doesn't work —
  // an all-empty-cells row is rejected by `isTableRowLine` (it requires at
  // least one non-empty cell) and would be dropped by the parser.
  const separator = `|${" --- |".repeat(columnCount)}`
  const parsed = parseMarkdown([headerText, separator].join("\n"))
  const blocks = parsed.content
  if (!blocks || blocks.length !== 1 || blocks[0].type !== "table") return null
  const table = blocks[0]
  const emptyRow: JSONContent = {
    type: "tableRow",
    content: Array.from({ length: columnCount }, () => ({
      type: "tableCell",
      attrs: { colspan: 1, rowspan: 1, colwidth: null },
      content: [{ type: "paragraph" }],
    })),
  }
  const tableJSON: JSONContent = {
    ...table,
    content: [...(table.content ?? []), emptyRow],
  }
  return { tableJSON, cursorTarget: "firstBodyCell" }
}

function countRowCells(line: string): number {
  const trimmed = line.trim()
  const body = trimmed.replace(/^\|/, "").replace(/\|$/, "")
  let count = 1
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "\\" && body[i + 1] === "|") {
      i++
      continue
    }
    if (body[i] === "|") count++
  }
  return count
}

function hasOuterPipes(line: string): boolean {
  const trimmed = line.trim()
  return trimmed.startsWith("|") && trimmed.endsWith("|") && trimmed.length > 1
}

function isAllSeparator(line: string): boolean {
  const trimmed = line.trim()
  const body = trimmed.replace(/^\|/, "").replace(/\|$/, "")
  return body.split("|").every((cell) => /^\s*:?-{3,}:?\s*$/.test(cell))
}

/**
 * Walk into the freshly inserted table and return an absolute position that
 * sits inside the first body cell. Falls back to the position just after the
 * table opening token if the table has no body row (shouldn't happen for the
 * single-header promotion path, but the math stays safe either way).
 */
function firstBodyCellTextPos(table: ProseMirrorNode, tableStartPos: number): number {
  let bodyRowOffset = -1
  let runningOffset = 1 // step inside the table node
  table.forEach((row, offset) => {
    if (bodyRowOffset >= 0) return
    if (row.firstChild?.type.name === "tableCell") {
      bodyRowOffset = runningOffset + offset
    }
  })
  if (bodyRowOffset < 0) return tableStartPos + 1
  // tableStartPos + bodyRowOffset == position before the row; +1 enters the
  // row, +1 enters the first cell, +1 enters the cell's first paragraph.
  return tableStartPos + bodyRowOffset + 3
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
