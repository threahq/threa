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

/** Enter splits a paragraph, and two paragraphs serialize to a blank line. */
const BLOCK_SEPARATOR = "\n\n"

/** One text block, with where its text lands in the run string it belongs to. */
interface ScanBlock {
  node: ProseMirrorNode
  /** Position of the block node itself, so its content starts at `pos + 1`. */
  pos: number
  textStart: number
  text: string
}

/** The part of one span that falls inside one block, in document positions. */
interface MathSegment {
  block: ScanBlock
  from: number
  to: number
  /** The span covers this block's whole text, so the block can be hidden. */
  whole: boolean
}

function buildMathDecorations(state: EditorState): DecorationSet {
  const { doc, selection } = state
  const decorations: Decoration[] = []

  for (const run of collectRuns(doc)) {
    const text = run.map((block) => block.text).join(BLOCK_SEPARATOR)

    for (const span of scanMathSpans(text)) {
      const segments = segmentsFor(run, span.from, span.to)
      if (segments.length === 0) continue

      const from = segments[0].from
      const to = segments[segments.length - 1].to
      // The caret touching the span means the author is editing the formula:
      // leave the TeX showing. The range is `[from, to)` — landing right after
      // the closing delimiter is *finishing* the equation, which is the moment
      // it should draw, while sitting on the opening one keeps the source (and
      // so the caret, which is inside hidden text) visible.
      if (selection.from < to && selection.to >= from) continue
      if (segments.some(messageWontRenderAsMath)) continue

      const html = renderMath(span.tex, span.display)
      const multiBlock = segments.length > 1
      for (const segment of segments) decorations.push(hideSource(segment, multiBlock))
      const at = widgetPos(segments[segments.length - 1], multiBlock)
      decorations.push(
        Decoration.widget(at, (view) => mathWidget(html, span.display, view), {
          side: 1,
          ignoreSelection: true,
          key: `${span.display ? "D" : "I"}:${span.tex}`,
        })
      )
    }
  }

  return DecorationSet.create(doc, decorations)
}

/**
 * The text blocks of the document in runs that serialize as one string.
 *
 * Display math is written across paragraphs — `$$`, the body, `$$` — because
 * Enter splits the block, so a scan that stopped at a block boundary previewed
 * nothing the author had to press Enter to write. Only top-level siblings join:
 * a paragraph inside a list item or a quote serializes with its marker in front
 * of every line, which is not math any more, so those blocks scan alone.
 */
function collectRuns(doc: ProseMirrorNode): ScanBlock[][] {
  const runs: ScanBlock[][] = []

  const walk = (parent: ProseMirrorNode, contentStart: number, joinable: boolean) => {
    let run: ScanBlock[] = []
    const flush = () => {
      if (run.length > 0) runs.push(run)
      run = []
    }

    parent.forEach((child, offset) => {
      const pos = contentStart + offset
      if (child.type.name === "codeBlock") {
        flush()
        return
      }
      if (child.isTextblock) {
        const previous = run[run.length - 1]
        const textStart = previous ? previous.textStart + previous.text.length + BLOCK_SEPARATOR.length : 0
        run.push({ node: child, pos, textStart, text: blockText(child) })
        if (!joinable) flush()
        return
      }
      flush()
      if (child.isBlock) walk(child, pos + 1, false)
    })

    flush()
  }

  walk(doc, 0, true)
  return runs
}

/**
 * Every inline leaf is one position wide, so it must contribute exactly one
 * character or every span after it decorates the wrong range. A hard break is
 * the newline it serializes to, so `$$⇧⏎x^2⇧⏎$$` reads the same here as in the
 * message.
 */
function blockText(node: ProseMirrorNode): string {
  return node.textBetween(0, node.content.size, "\n", (leaf) => (leaf.type.name === "hardBreak" ? "\n" : "￼"))
}

/** Where `[from, to)` of the run string lands in each block it crosses. */
function segmentsFor(run: ScanBlock[], from: number, to: number): MathSegment[] {
  const segments: MathSegment[] = []

  for (const block of run) {
    const start = block.textStart
    const end = start + block.text.length
    if (end < from || start > to) continue

    const whole = start >= from && end <= to
    const segmentFrom = Math.max(start, from)
    const segmentTo = Math.min(end, to)
    // A block the span only touches at a boundary contributes nothing; an empty
    // paragraph swallowed by a display span is still hidden.
    if (!whole && segmentFrom >= segmentTo) continue

    segments.push({
      block,
      from: block.pos + 1 + (segmentFrom - start),
      to: block.pos + 1 + (segmentTo - start),
      whole,
    })
  }

  return segments
}

/**
 * A block the span owns outright is hidden as a block, so the line it occupied
 * collapses; anything else hides just the characters. A span inside a single
 * paragraph always takes the inline form — hiding that paragraph would take the
 * equation's own line with it.
 */
function hideSource(segment: MathSegment, multiBlock: boolean): Decoration {
  if (multiBlock && segment.whole) {
    return Decoration.node(segment.block.pos, segment.block.pos + segment.block.node.nodeSize, {
      class: "math-source-block",
    })
  }
  return Decoration.inline(segment.from, segment.to, { class: "math-source" })
}

function widgetPos(last: MathSegment, multiBlock: boolean): number {
  if (multiBlock && last.whole) return last.block.pos + last.block.node.nodeSize
  return last.to
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
function messageWontRenderAsMath(segment: MathSegment): boolean {
  const content = segment.block.pos + 1
  let refused = false
  segment.block.node.nodesBetween(segment.from - content, segment.to - content, (child) => {
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
  // Clicking the equation puts the caret inside its source, which reveals the
  // TeX in place: one tap to edit, on a phone as on a desktop. It has to land
  // one position short of the end — the end itself is where an equation draws.
  // The position is read from the DOM at click time, because two equations with
  // the same TeX share a decoration key and the DOM is reused between them.
  element.addEventListener("mousedown", (event) => {
    event.preventDefault()
    const after = TextSelection.near(view.state.doc.resolve(view.posAtDOM(element, 0)), -1).from
    const inside = view.state.doc.resolve(Math.max(1, after - 1))
    view.dispatch(view.state.tr.setSelection(TextSelection.near(inside, -1)).scrollIntoView())
    view.focus()
  })
  return element
}
