import { InputRule, Node, mergeAttributes } from "@tiptap/core"
import type { Node as ProseMirrorNode } from "@tiptap/pm/model"
import { NodeSelection, Plugin, PluginKey, TextSelection } from "@tiptap/pm/state"
import { Decoration, DecorationSet } from "@tiptap/pm/view"
import { ReactNodeViewRenderer } from "@tiptap/react"
import { scanMathSpans } from "@threahq/prosemirror"
import { MathNodeView } from "./math-node-view"

export interface MathAttrs {
  /** The TeX body, without delimiters — they exist only in serialized markdown. */
  tex: string
  /** Centered on its own line (`$$…$$`) rather than inside the sentence (`$…$`). */
  display: boolean
}

/**
 * Which math node, if any, has its TeX field open. Editing state lives in a
 * transaction rather than in React, so it survives the node view being rebuilt
 * and maps through every edit that moves the node.
 */
export const MathEditingKey = new PluginKey<number | null>("mathEditing")

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    math: {
      /** Turn the selection into an equation, or start an empty one, and open its TeX field. */
      insertMath: (attrs?: { display?: boolean }) => ReturnType
      /** Open the TeX field of the math node at `pos`. */
      openMathEditor: (pos: number) => ReturnType
      /** Write the field back, leaving the caret after the equation. Empty TeX deletes the node. */
      commitMath: (pos: number, attrs: MathAttrs) => ReturnType
    }
  }
}

/**
 * An equation as a node, the way a code block is one: the `$` delimiters are
 * markdown, never characters in the document. KaTeX draws it, a tap opens its
 * TeX in place, and backspace takes the whole equation rather than silently
 * breaking a hidden delimiter.
 *
 * Inline atom rather than a block: `$$…$$` sits inside a paragraph in markdown,
 * and the message renderer puts its display equation there too, so the node
 * that round-trips to it belongs in the same place. `display` decides how it
 * draws, not where it lives.
 *
 * `marks: ""` — the equation's appearance comes from its TeX, so bold or a link
 * on it would be a promise the sent message cannot keep.
 */
export const MathExtension = Node.create({
  name: "math",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  marks: "",

  addAttributes() {
    return {
      tex: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-tex") ?? "",
        renderHTML: (attrs) => ({ "data-tex": attrs.tex }),
      },
      display: {
        default: false,
        parseHTML: (element) => element.getAttribute("data-display") === "true",
        renderHTML: (attrs) => ({ "data-display": attrs.display ? "true" : "false" }),
      },
    }
  },

  parseHTML() {
    return [{ tag: 'span[data-type="math"]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes, { "data-type": "math" })]
  },

  /** Copied or read as plain text, an equation is the source that produced it. */
  renderText({ node }) {
    const { tex, display } = node.attrs as MathAttrs
    return display ? `$$${tex}$$` : `$${tex}$`
  },

  addCommands() {
    return {
      insertMath:
        (attrs) =>
        ({ state, dispatch }) => {
          const { $from, $to, from, to, empty } = state.selection
          // A selection crossing a block boundary or holding an inline atom — a
          // mention, an emoji, an attachment reference — cannot become the TeX:
          // its text form merges the blocks into one line and drops the atom.
          // The equation then starts empty at the end of the selection rather
          // than replacing what was selected with a lossy copy of it.
          const wrappable = !empty && $from.sameParent($to) && !holdsInlineAtom(state.doc, from, to)
          const tex = wrappable ? state.doc.textBetween(from, to, "\n", "").trim() : ""
          const start = wrappable ? from : to
          if (!dispatch) return true

          const node = this.type.create({ tex, display: attrs?.display === true || tex.includes("\n") })
          const tr = state.tr.replaceWith(start, to, node)
          dispatch(tr.setSelection(NodeSelection.create(tr.doc, start)).setMeta(MathEditingKey, start).scrollIntoView())
          return true
        },

      openMathEditor:
        (pos) =>
        ({ state, dispatch }) => {
          const node = state.doc.nodeAt(pos)
          if (!node || node.type !== this.type) return false
          if (dispatch) {
            dispatch(state.tr.setSelection(NodeSelection.create(state.doc, pos)).setMeta(MathEditingKey, pos))
          }
          return true
        },

      commitMath:
        (pos, attrs) =>
        ({ state, dispatch }) => {
          const node = state.doc.nodeAt(pos)
          if (!node || node.type !== this.type) return false
          if (!dispatch) return true

          const tex = attrs.tex.trim()
          const tr = state.tr.setMeta(MathEditingKey, null)
          if (tex) {
            tr.setNodeMarkup(pos, undefined, { tex, display: attrs.display || tex.includes("\n") })
          } else {
            // An equation with no TeX draws nothing, so leaving it would leave
            // an invisible node the caret has to step over.
            tr.delete(pos, pos + node.nodeSize)
          }
          // After the equation, never before it: finishing one is like finishing
          // any other block, and a caret ahead of what you just wrote is the
          // thing decorations got wrong.
          const after = tex ? pos + node.nodeSize : pos
          tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(after, tr.doc.content.size))))
          dispatch(tr.scrollIntoView())
          return true
        },
    }
  },

  /**
   * A finished `$…$` / `$$…$$` / `\(…\)` / `\[…\]` becomes the node as the
   * closing delimiter lands, so typing an equation and inserting one from the
   * toolbar end in the same place. The candidate is put through
   * `scanMathSpans` rather than trusted from the regex: that is the scanner the
   * sent message reads, so `costs $5 and $10` stays prose here too.
   */
  addInputRules() {
    return [
      new InputRule({
        find: /(?:\$|\\\)|\\\])$/,
        handler: ({ state, range, match }) => {
          // The typed character is not in the document yet — the rule runs
          // before it lands — so the closing delimiter comes from the match.
          const $from = state.doc.resolve(range.from)
          const blockStart = $from.start()
          const text = blockText($from.parent, range.from - blockStart) + match[0]
          const span = scanMathSpans(text).find((candidate) => candidate.to === text.length)
          const tex = span?.tex.trim()
          if (!span || !tex) return null
          if (holdsInlineAtom(state.doc, blockStart + span.from, range.to)) return null

          state.tr.replaceWith(
            blockStart + span.from,
            range.to,
            state.schema.nodes.math.create({ tex, display: span.display })
          )
          return undefined
        },
      }),
    ]
  },

  addProseMirrorPlugins() {
    return [
      new Plugin<number | null>({
        key: MathEditingKey,
        state: {
          init: () => null,
          apply(tr, value) {
            const meta = tr.getMeta(MathEditingKey) as number | null | undefined
            if (meta !== undefined) return meta
            if (value === null) return null
            const mapped = tr.mapping.mapResult(value)
            return mapped.deleted ? null : mapped.pos
          },
        },
        props: {
          decorations(state) {
            const pos = MathEditingKey.getState(state)
            if (pos === null || pos === undefined) return null
            const node = state.doc.nodeAt(pos)
            if (!node || node.type.name !== "math") return null
            return DecorationSet.create(state.doc, [
              Decoration.node(pos, pos + node.nodeSize, {}, { mathEditing: true }),
            ])
          },
        },
      }),
    ]
  },

  addNodeView() {
    return ReactNodeViewRenderer(MathNodeView)
  },
})

/**
 * The block's text up to `end`, with every inline leaf standing in as one
 * character so the scanner's offsets are document offsets. A hard break is the
 * newline it serializes to, which is how `$$` written across soft lines reads
 * as one display equation.
 */
function blockText(node: ProseMirrorNode, end: number): string {
  return node.textBetween(0, end, "\n", (leaf) => (leaf.type.name === "hardBreak" ? "\n" : "￼"))
}

function holdsInlineAtom(doc: ProseMirrorNode, from: number, to: number): boolean {
  let found = false
  doc.nodesBetween(from, to, (node) => {
    // A hard break is not one: it is the newline display math is written with.
    if (node.isLeaf && !node.isText && node.type.name !== "hardBreak") found = true
  })
  return found
}
