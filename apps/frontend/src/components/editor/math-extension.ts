import { InputRule, Node, mergeAttributes } from "@tiptap/core"
import type { Editor } from "@tiptap/core"
import type { Node as ProseMirrorNode, NodeType } from "@tiptap/pm/model"
import { NodeSelection, Plugin, PluginKey, TextSelection, type EditorState } from "@tiptap/pm/state"
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

/** Which end of the TeX the caret takes when the field opens. */
export type MathCaretSide = "start" | "end"

/** Where the caret goes once the field closes. */
export type MathExitSide = "before" | "after"

export interface MathEditingState {
  pos: number
  caret: MathCaretSide
}

/**
 * Which math node, if any, has its TeX field open, and which end of it the
 * caret took. Editing state lives in a transaction rather than in React, so it
 * survives the node view being rebuilt and maps through every edit that moves
 * the node.
 */
export const MathEditingKey = new PluginKey<MathEditingState | null>("mathEditing")

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    math: {
      /** Turn the selection into an equation, or start an empty one, and open its TeX field. */
      insertMath: (attrs?: { display?: boolean }) => ReturnType
      /** Open the TeX field of the math node at `pos`, caret at the given end. */
      openMathEditor: (pos: number, caret?: MathCaretSide) => ReturnType
      /** Write the field back, leaving the caret beside the equation. Empty TeX deletes the node. */
      commitMath: (pos: number, attrs: MathAttrs, exit?: MathExitSide) => ReturnType
    }
  }
}

/**
 * An equation as a node, the way a code block is one: the `$` delimiters are
 * markdown, never characters in the document. KaTeX draws it, a tap or the
 * caret arriving opens its TeX in place, and backspace takes the whole equation
 * rather than silently breaking a hidden delimiter.
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
          dispatch(
            tr
              .setSelection(NodeSelection.create(tr.doc, start))
              .setMeta(MathEditingKey, { pos: start, caret: "end" })
              .scrollIntoView()
          )
          return true
        },

      openMathEditor:
        (pos, caret = "end") =>
        ({ state, dispatch }) => {
          const node = state.doc.nodeAt(pos)
          if (!node || node.type !== this.type) return false
          if (dispatch) {
            dispatch(
              state.tr.setSelection(NodeSelection.create(state.doc, pos)).setMeta(MathEditingKey, { pos, caret })
            )
          }
          return true
        },

      commitMath:
        (pos, attrs, exit = "after") =>
        ({ state, dispatch }) => {
          const node = state.doc.nodeAt(pos)
          if (!node || node.type !== this.type) return false
          if (!dispatch) return true

          const tex = attrs.tex.trim()
          const display = attrs.display || tex.includes("\n")
          const tr = state.tr.setMeta(MathEditingKey, null)
          if (!tex) {
            // An equation with no TeX draws nothing, so leaving it would leave
            // an invisible node the caret has to step over.
            tr.delete(pos, pos + node.nodeSize)
          } else if (tex !== node.attrs.tex || display !== node.attrs.display) {
            // Unchanged TeX writes nothing, so arrowing through an equation
            // does not fill the undo history with no-op steps.
            tr.setNodeMarkup(pos, undefined, { tex, display })
          }
          // Beside the equation on the side the caret left by, never inside a
          // node it can no longer render — and after it when the field was
          // finished rather than stepped out of, because finishing an equation
          // is like finishing any other block.
          const target = !tex || exit === "before" ? pos : pos + node.nodeSize
          tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(target, tr.doc.content.size))))
          dispatch(tr.scrollIntoView())
          return true
        },
    }
  },

  /**
   * The caret arriving at an equation opens its TeX, the way arrowing into a
   * code block puts the caret in its source: an equation you can walk onto but
   * not into would be a dead end on a keyboard, and the node selection it lands
   * on otherwise is replaced wholesale by the next character typed.
   */
  addKeyboardShortcuts() {
    return {
      ArrowLeft: () => openAdjacentMath(this.editor, this.type, "left"),
      ArrowRight: () => openAdjacentMath(this.editor, this.type, "right"),
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
      new Plugin<MathEditingState | null>({
        key: MathEditingKey,
        state: {
          init: () => null,
          apply(tr, value) {
            const meta = tr.getMeta(MathEditingKey) as MathEditingState | null | undefined
            if (meta !== undefined) return meta
            if (value === null) return null
            const mapped = tr.mapping.mapResult(value.pos)
            return mapped.deleted ? null : { pos: mapped.pos, caret: value.caret }
          },
        },
        props: {
          decorations(state) {
            const editing = MathEditingKey.getState(state)
            if (!editing) return null
            const node = state.doc.nodeAt(editing.pos)
            if (!node || node.type.name !== "math") return null
            return DecorationSet.create(state.doc, [
              Decoration.node(
                editing.pos,
                editing.pos + node.nodeSize,
                {},
                { mathEditing: true, mathCaret: editing.caret }
              ),
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
 * Open the TeX of a math node the caret is about to step over, entering it from
 * the side the caret came from. Returns false everywhere else, so every other
 * arrow press is the editor's own.
 */
function openAdjacentMath(editor: Editor, type: NodeType, direction: "left" | "right"): boolean {
  const { selection } = editor.state
  if (!(selection instanceof TextSelection) || !selection.empty) return false

  const { $from } = selection
  if (direction === "left") {
    const before = $from.nodeBefore
    if (before?.type !== type) return false
    return editor.commands.openMathEditor($from.pos - before.nodeSize, "end")
  }

  const after = $from.nodeAfter
  if (after?.type !== type) return false
  return editor.commands.openMathEditor($from.pos, "start")
}

/**
 * Open the TeX of a selected equation. A math node can still be selected rather
 * than opened — select-all, a drag across it — and Enter on it should be the
 * way in, not the keystroke that sends the message it sits in.
 */
export function openSelectedMath(editor: Editor): boolean {
  const { selection } = editor.state
  if (!(selection instanceof NodeSelection) || selection.node.type.name !== "math") return false
  return editor.commands.openMathEditor(selection.from, "end")
}

/** The math node whose TeX field is open, if any. */
export function mathEditingState(state: EditorState): MathEditingState | null {
  return MathEditingKey.getState(state) ?? null
}

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
