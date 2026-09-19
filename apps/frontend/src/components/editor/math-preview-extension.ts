import { Extension } from "@tiptap/core"
import { Plugin, PluginKey, TextSelection, type EditorState } from "@tiptap/pm/state"
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view"
import type { Node as ProseMirrorNode } from "@tiptap/pm/model"
import katex from "katex"
import "katex/dist/katex.min.css"
import { scanMathSpans } from "@threahq/prosemirror"
import { KATEX_OPTIONS } from "@/lib/markdown/katex-options"

const MathPreviewPluginKey = new PluginKey<DecorationSet>("mathPreview")

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

    return [
      new Plugin<DecorationSet>({
        key: MathPreviewPluginKey,
        state: {
          init: (_config, state) => buildMathDecorations(state),
          // An IME composition owns the DOM around the caret. Rebuilding
          // decorations under it drops the composition on Android, so the old
          // set is mapped through the edit instead — the ranges keep covering
          // the text they were built for until the composition ends.
          apply: (tr, decorations, _old, state) =>
            editor.view?.composing ? decorations.map(tr.mapping, tr.doc) : buildMathDecorations(state),
        },
        props: {
          decorations(state) {
            return MathPreviewPluginKey.getState(state)
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

    // Every inline leaf is one position wide, so it must contribute exactly one
    // character or every span after it decorates the wrong range. A hard break
    // is the newline it serializes to, so `$$⏎x^2⏎$$` reads the same here as in
    // the message.
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
      if (messageWontRenderAsMath(node, span.from, span.to)) continue

      const html = renderMath(span.tex, span.display)
      decorations.push(Decoration.inline(from, to, { class: "math-source" }))
      decorations.push(
        Decoration.widget(to, (view) => mathWidget(html, span.display, view), {
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
 * True when the posted message will not render this span as math, which makes
 * drawing an equation for it a lie about what sending does.
 *
 * A code mark is text `extractMath` never looks inside, and a link's
 * destination is not TeX. An inline atom — a mention, an emoji, an attachment
 * reference — serializes to a markdown link like `[@alice](user:usr_1)`, and
 * `extractMath`'s PROTECTED pattern refuses to read `](…)` as math, so the
 * message shows the raw `$…$`. A hard break is not an atom here: it serializes
 * to the newline display math is written with.
 */
function messageWontRenderAsMath(node: ProseMirrorNode, from: number, to: number): boolean {
  let refused = false
  node.nodesBetween(from, to, (child) => {
    if (child.marks.some((mark) => mark.type.name === "code" || mark.type.name === "link")) refused = true
    if (child.isLeaf && !child.isText && child.type.name !== "hardBreak") refused = true
  })
  return refused
}

/**
 * Every span in the document is re-rendered on every transaction, caret moves
 * included, and KaTeX costs ~0.4ms per equation. Keyed by the same string the
 * widget is keyed by; cleared wholesale rather than evicted because the entries
 * are small and a composer rarely holds more than a handful of distinct spans.
 */
const renderedMath = new Map<string, string>()

function renderMath(tex: string, display: boolean): string {
  const key = `${display ? "D" : "I"}:${tex}`
  const cached = renderedMath.get(key)
  if (cached !== undefined) return cached

  const html = katex.renderToString(tex, { ...KATEX_OPTIONS, displayMode: display })
  if (renderedMath.size >= 200) renderedMath.clear()
  renderedMath.set(key, html)
  return html
}

function mathWidget(html: string, display: boolean, view: EditorView): HTMLElement {
  const element = document.createElement("span")
  element.className = display ? "math-preview math-preview-block" : "math-preview math-preview-inline"
  element.innerHTML = html
  element.contentEditable = "false"
  // Clicking the equation puts the caret at the end of its source, which
  // reveals the TeX in place: one tap to edit, on a phone as on a desktop.
  // The position is read from the DOM at click time — two equations with the
  // same TeX share a decoration key, so this element may have been drawn for a
  // span that later edits moved.
  element.addEventListener("mousedown", (event) => {
    event.preventDefault()
    const pos = view.posAtDOM(element, 0)
    const tr = view.state.tr.setSelection(TextSelection.create(view.state.doc, pos))
    view.dispatch(tr.scrollIntoView())
    view.focus()
  })
  return element
}
