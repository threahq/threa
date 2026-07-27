/**
 * Paste-without-formatting (cmd/ctrl+shift+V).
 *
 * The clipboard's `text/plain` flavour is markdown — that is what makes a copy
 * survive a trip through any other app. Pasting it literally is what put
 * `**bold**` in the composer, so this path renders the markdown back to the
 * text it stands for and inserts that, with no marks and no block structure.
 * Plain paste is then the exact counterpart of a normal paste: same content,
 * styling dropped.
 */
import { Fragment, Slice } from "@tiptap/pm/model"
import { getText, getTextSerializersFromSchema, type Editor } from "@tiptap/core"
import type { EditorView } from "@tiptap/pm/view"
import { parseMarkdown, type EmojiLookup, type MentionTypeLookup, type ParseMarkdownOptions } from "./editor-markdown"

/**
 * ProseMirror's own paste-without-formatting signal. It records the shift key
 * on keydown/keyup and reads `input.shiftKey` to decide whether to insert the
 * clipboard's plain-text flavour verbatim; shift+Insert (keyCode 45) is a
 * normal paste. Reading the same field keeps the two handlers on one rule
 * rather than tracking the modifier a second time. If a ProseMirror upgrade
 * renames it, plain paste degrades to the previous behaviour —
 * `plain-text-paste.test.ts` fails on the rename so it can't pass unnoticed.
 */
export function isPlainTextPaste(view: EditorView): boolean {
  const input = (view as unknown as { input?: { shiftKey?: boolean; lastKeyCode?: number } }).input
  return input?.shiftKey === true && input.lastKeyCode !== 45
}

export function markdownToPlainText(
  editor: Editor,
  markdown: string,
  getMentionType?: MentionTypeLookup,
  getEmoji?: EmojiLookup,
  parseOptions?: ParseMarkdownOptions
): string {
  const parsed = parseMarkdown(markdown, getMentionType, getEmoji, { emojiAsText: true, ...parseOptions })
  const doc = editor.schema.nodeFromJSON(parsed)
  const text = getText(doc, { blockSeparator: "\n", textSerializers: getTextSerializersFromSchema(editor.schema) })
  // A nested block (a quote's or list item's paragraph) crosses two block
  // boundaries and so emits a separator per level; the result is one line per
  // block, and none before the first or after the last.
  return text.replace(/\n{2,}/g, "\n").replace(/^\n+|\n+$/g, "")
}

export function insertPlainText(
  editor: Editor,
  text: string,
  getMentionType?: MentionTypeLookup,
  getEmoji?: EmojiLookup,
  parseOptions?: ParseMarkdownOptions
): boolean {
  const normalizedText = text.replace(/\r\n?/g, "\n")

  // The paste is prevented before inserting, so a parse failure must never eat
  // the payload — the raw text goes in instead.
  let plainText = normalizedText
  try {
    plainText = markdownToPlainText(editor, normalizedText, getMentionType, getEmoji, parseOptions)
  } catch {
    plainText = normalizedText
  }

  if (editor.isActive("codeBlock")) {
    return editor
      .chain()
      .focus()
      .command(({ tr }) => {
        tr.insertText(plainText)
        return true
      })
      .run()
  }

  const lines = plainText.split("\n")
  if (lines.length === 1) {
    return editor
      .chain()
      .focus()
      .command(({ tr }) => {
        tr.insertText(plainText)
        return true
      })
      .run()
  }

  // Open at both ends so the first and last lines merge with the paragraph
  // around the cursor, matching native paste behaviour.
  const { schema } = editor.state
  const paragraphs = lines.map((line) => schema.nodes.paragraph.create(null, line ? schema.text(line) : null))
  return editor
    .chain()
    .focus()
    .command(({ tr }) => {
      tr.replaceSelection(new Slice(Fragment.fromArray(paragraphs), 1, 1))
      return true
    })
    .run()
}
