import type { Editor } from "@tiptap/core"
import { TextSelection } from "@tiptap/pm/state"

/**
 * Wrap the selection in inline math delimiters, or insert an empty pair with
 * the caret between them.
 *
 * A `$` glued to a word is not an opener — `scanMathSpans` rejects it so
 * `costs$5` stays prose — so a separating space goes in when the caret sits
 * right after one, and the button can't produce delimiters that render as
 * dollar signs. Wrapping leaves the caret after the closing delimiter, which
 * keeps the TeX showing until the author moves on, exactly as typing the pair
 * by hand does; an empty pair leaves the caret inside, ready for TeX.
 */
export function insertMath(editor: Editor) {
  const { state } = editor
  const { from, to, empty } = state.selection
  const body = empty ? "" : state.doc.textBetween(from, to, "\n", "")
  const before = from > 1 ? state.doc.textBetween(from - 1, from, "\n", "") : ""
  const lead = /[\w$\\]/.test(before) ? " " : ""
  const text = `${lead}$${body}$`
  const caret = empty ? from + lead.length + 1 : from + text.length

  // `insertText`, not `insertContent`: a string given to TipTap is parsed as
  // HTML, which would eat a `<` in the wrapped text.
  const tr = state.tr.insertText(text, from, to)
  tr.setSelection(TextSelection.create(tr.doc, caret))
  editor.view.dispatch(tr.scrollIntoView())
  editor.view.focus()
}
