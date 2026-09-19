import { Extension } from "@tiptap/core"
import { Plugin, PluginKey, TextSelection, type EditorState } from "@tiptap/pm/state"
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view"
import type { Node as ProseMirrorNode } from "@tiptap/pm/model"
import katex from "katex"
import "katex/dist/katex.min.css"
import { scanMathSpans } from "@threahq/prosemirror"

const MathPreviewPluginKey = new PluginKey("mathPreview")

/**
 * Draws a math span as the equation the message will render, the way
 * `CommandArgDecoration` draws a command's arguments as its chips.
 *
 * View-only inline decorations, never nodes or marks: the document keeps the
 * author's `$…$` as plain text, so serialization, copy, undo, drafts and every
 * other surface that parses composer content are untouched. The span the caret
 * sits in stays raw TeX, which is what makes a tap on an equation the gesture
 * that edits it.
 */
export const MathPreview = Extension.create({
  name: "mathPreview",

  addProseMirrorPlugins() {
    const editor = this.editor
    let cached = DecorationSet.empty

    return [
      new Plugin({
        key: MathPreviewPluginKey,
        props: {
          decorations(state) {
            // An IME composition owns the DOM around the caret. Rebuilding
            // decorations under it drops the composition on Android, and the
            // span being composed into is the caret's own, which is raw anyway.
            if (editor.view?.composing) return cached
            cached = buildMathDecorations(state)
            return cached
          },
        },
      }),
    ]
  },
})

function buildMathDecorations(state: EditorState): DecorationSet {
  const { doc, selection } = state
  const decorations: Decoration[] = []

  doc.descendants((node, pos) => {
    if (node.type.name === "codeBlock") return false
    if (!node.isTextblock) return true

    // Every inline leaf (a mention, an emoji, an attachment reference) is one
    // position wide, so it must contribute exactly one character or every span
    // after it decorates the wrong range. A hard break is the newline it
    // serializes to, so `$$⏎x^2⏎$$` reads the same here as in the message.
    const text = node.textBetween(0, node.content.size, "\n", (leaf) => (leaf.type.name === "hardBreak" ? "\n" : "￼"))

    for (const span of scanMathSpans(text)) {
      const from = pos + 1 + span.from
      const to = pos + 1 + span.to
      // The caret inside the span means the author is editing the formula:
      // leave the TeX showing. The range is `(from, to]` — sitting right after
      // the closing delimiter is editing it (that is where clicking the
      // equation lands the caret), sitting right before the opening one is not,
      // so typing ahead of an equation doesn't flicker it open.
      if (selection.to > from && selection.from <= to) continue
      if (spanCarriesFormatting(node, span.from, span.to)) continue

      const html = renderMath(span.tex, span.display)
      decorations.push(Decoration.inline(from, to, { class: "math-source" }))
      decorations.push(
        Decoration.widget(to, (view) => mathWidget(html, span.display, view, to), {
          side: 1,
          ignoreSelection: true,
          key: `${span.display ? "D" : "I"}:${span.tex}`,
        })
      )
    }
    return false
  })

  return DecorationSet.create(doc, decorations)
}

/**
 * True when a link or code mark covers any of the span. Both change what the
 * span means once it is sent: `extractMath` never looks inside a code span, and
 * a link's destination is not TeX. Drawing an equation over either would show
 * something the message will not render.
 */
function spanCarriesFormatting(node: ProseMirrorNode, from: number, to: number): boolean {
  let formatted = false
  node.nodesBetween(from, to, (child) => {
    if (child.marks.some((mark) => mark.type.name === "code" || mark.type.name === "link")) formatted = true
  })
  return formatted
}

/**
 * The same call `MarkdownContent` makes through `rehype-katex`, with the same
 * options, so the composer cannot draw an equation the message renders
 * differently. TeX that does not compile becomes KaTeX's error box here exactly
 * as it does there; TeX that is merely half-typed has no closing delimiter yet,
 * so it is not a span at all and nothing is drawn.
 */
function renderMath(tex: string, display: boolean): string {
  return katex.renderToString(tex, { displayMode: display, throwOnError: false, strict: "ignore", maxSize: 10 })
}

function mathWidget(html: string, display: boolean, view: EditorView, to: number): HTMLElement {
  const element = document.createElement(display ? "div" : "span")
  element.className = display ? "math-preview math-preview-block" : "math-preview math-preview-inline"
  element.innerHTML = html
  element.contentEditable = "false"
  // Clicking the equation puts the caret at the end of its source, which
  // reveals the TeX in place: one tap to edit, on a phone as on a desktop.
  element.addEventListener("mousedown", (event) => {
    event.preventDefault()
    const tr = view.state.tr.setSelection(TextSelection.create(view.state.doc, to))
    view.dispatch(tr.scrollIntoView())
    view.focus()
  })
  return element
}
