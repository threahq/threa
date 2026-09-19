import type { Editor } from "@tiptap/core"
import type { Node as ProseMirrorNode } from "@tiptap/pm/model"
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
  const { $from, $to, from, to, empty } = state.selection
  // A selection crossing a block boundary or holding an inline atom (a
  // mention, an emoji, an attachment reference) cannot become the body: its
  // text form merges the blocks into one line and drops the atom entirely, and
  // a mention inside `$…$` is not math to `extractMath` anyway. The button
  // still inserts a pair, at the end of the selection, rather than replacing
  // what was selected with a lossy copy of it.
  const wrappable = !empty && $from.sameParent($to) && !holdsInlineAtom(state.doc, from, to)
  const start = wrappable ? from : to

  const body = wrappable ? state.doc.textBetween(from, to, "\n", "") : ""
  const before = start > 1 ? state.doc.textBetween(start - 1, start, "\n", "") : ""
  const lead = /[\w$\\]/.test(before) ? " " : ""
  const text = `${lead}$${body}$`
  const caret = wrappable ? start + text.length : start + lead.length + 1

  // `insertText`, not `insertContent`: a string given to TipTap is parsed as
  // HTML, which would eat a `<` in the wrapped text.
  const tr = state.tr.insertText(text, start, to)
  tr.setSelection(TextSelection.create(tr.doc, caret))
  editor.view.dispatch(tr.scrollIntoView())
  editor.view.focus()
}

function holdsInlineAtom(doc: ProseMirrorNode, from: number, to: number): boolean {
  let found = false
  doc.nodesBetween(from, to, (node) => {
    // A hard break is not one: it is the newline inline math may contain.
    if (node.isLeaf && !node.isText && node.type.name !== "hardBreak") found = true
  })
  return found
}
