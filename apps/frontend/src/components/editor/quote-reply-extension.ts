import { Node, mergeAttributes } from "@tiptap/core"
import { GapCursor } from "@tiptap/pm/gapcursor"
import type { ResolvedPos } from "@tiptap/pm/model"
import { NodeSelection, Plugin, PluginKey, Selection } from "@tiptap/pm/state"
import { ReactNodeViewRenderer } from "@tiptap/react"
import type { ContentRange } from "@threa/types"
import { QuoteReplyView } from "./quote-reply-view"
import { referencePinAttributes } from "./reference-attributes"

function isValidGapCursorPosition($pos: ResolvedPos): boolean {
  const gapCursor = GapCursor as typeof GapCursor & {
    valid?: (position: ResolvedPos) => boolean
  }

  return gapCursor.valid?.($pos) ?? false
}

function insertParagraphAtGapCursor(
  editor: {
    state: import("@tiptap/pm/state").EditorState
    view: import("@tiptap/pm/view").EditorView
  },
  text = ""
): boolean {
  const { state } = editor
  if (!(state.selection instanceof GapCursor)) return false

  const pos = state.selection.$from.pos
  const paragraph = state.schema.nodes.paragraph.create()
  let tr = state.tr.insert(pos, paragraph)
  const selectionPos = pos + 1

  if (text.length > 0) {
    tr = tr.insertText(text, selectionPos)
  }

  tr.setSelection(Selection.near(tr.doc.resolve(selectionPos + text.length)))
  editor.view.dispatch(tr.scrollIntoView())
  return true
}

function syncGapCursorStyles(view: import("@tiptap/pm/view").EditorView) {
  const root = view.dom as HTMLElement
  const el = root.querySelector(".ProseMirror-gapcursor") as HTMLElement | null

  root.classList.remove("has-after-quote-gapcursor")

  if (!el) {
    return
  }

  el.classList.remove("before-quote", "after-quote")
  el.style.removeProperty("--quote-top")
  el.style.removeProperty("--quote-height")
  el.style.removeProperty("--quote-right")

  const next = getAdjacentQuoteReplyElement(el.nextElementSibling)
  const prev = getAdjacentQuoteReplyElement(el.previousElementSibling)

  if (next) {
    el.classList.add("before-quote")
    const quoteRect = next.getBoundingClientRect()
    const gcRect = el.getBoundingClientRect()
    el.style.setProperty("--quote-top", `${quoteRect.top - gcRect.top}px`)
    el.style.setProperty("--quote-height", `${quoteRect.height}px`)
    return
  }

  if (prev) {
    el.classList.add("after-quote")
    const quoteRect = prev.getBoundingClientRect()
    const gcRect = el.getBoundingClientRect()
    el.style.setProperty("--quote-top", `${quoteRect.top - gcRect.top}px`)
    el.style.setProperty("--quote-height", `${quoteRect.height}px`)
    el.style.setProperty("--quote-right", `${root.getBoundingClientRect().right - quoteRect.right}px`)

    if (!el.nextElementSibling) {
      root.classList.add("has-after-quote-gapcursor")
    }
  }
}

function getAdjacentQuoteReplyElement(element: Element | null): HTMLElement | null {
  if (!(element instanceof HTMLElement)) {
    return null
  }

  if (element.getAttribute("data-type") === "quote-reply") {
    return element
  }

  const nested = element.querySelector<HTMLElement>('[data-type="quote-reply"]')
  return nested ?? null
}

function setGapCursorSelection(
  editor: {
    state: import("@tiptap/pm/state").EditorState
    view: import("@tiptap/pm/view").EditorView
  },
  pos: number
): boolean {
  const $pos = editor.state.doc.resolve(pos)
  if (!isValidGapCursorPosition($pos)) {
    return false
  }

  editor.view.dispatch(editor.state.tr.setSelection(new GapCursor($pos)).scrollIntoView())
  return true
}

function moveAcrossQuoteReply(
  editor: {
    state: import("@tiptap/pm/state").EditorState
    view: import("@tiptap/pm/view").EditorView
  },
  direction: "left" | "right"
): boolean {
  const { selection } = editor.state

  if (selection instanceof GapCursor) {
    if (direction === "left" && selection.$from.nodeBefore?.type.name === "quoteReply") {
      return setGapCursorSelection(editor, selection.from - selection.$from.nodeBefore.nodeSize)
    }

    if (direction === "right" && selection.$from.nodeAfter?.type.name === "quoteReply") {
      return setGapCursorSelection(editor, selection.from + selection.$from.nodeAfter.nodeSize)
    }

    return false
  }

  if (selection instanceof NodeSelection && selection.node.type.name === "quoteReply") {
    return setGapCursorSelection(editor, direction === "left" ? selection.from : selection.to)
  }

  return false
}

function handleQuoteReplyClick(
  editor: {
    state: import("@tiptap/pm/state").EditorState
    view: import("@tiptap/pm/view").EditorView
  },
  node: import("@tiptap/pm/model").Node,
  nodePos: number,
  event: MouseEvent,
  direct: boolean
): boolean {
  if (!direct || node.type.name !== "quoteReply" || event.button !== 0) {
    return false
  }

  const target = event.target
  if (target instanceof HTMLElement && target.closest("button,a")) {
    return false
  }

  const nodeDom = editor.view.nodeDOM(nodePos)
  const quoteElement = getAdjacentQuoteReplyElement(nodeDom instanceof Element ? nodeDom : null)
  if (!quoteElement) {
    return false
  }

  const quoteRect = quoteElement.getBoundingClientRect()
  const targetPos = event.clientX <= quoteRect.left + quoteRect.width / 2 ? nodePos : nodePos + node.nodeSize

  if (!setGapCursorSelection(editor, targetPos)) {
    return false
  }

  event.preventDefault()
  editor.view.focus()
  return true
}

export interface QuoteReplyAttrs {
  /** The ID of the quoted message */
  messageId: string
  /** The stream containing the quoted message */
  streamId: string
  /** Display name of the quoted message author (denormalized) */
  authorName: string
  /** The ID of the quoted message author */
  authorId: string
  /** The actor type of the quoted message author */
  actorType: string
  /** The quoted text snippet */
  snippet: string
  /** Source message revision this quote is pinned to; null = unpinned */
  version: number | null
  /** Span inside the pinned version; null = the whole message */
  range: ContentRange | null
}

export const QuoteReplyExtension = Node.create({
  name: "quoteReply",
  group: "block",
  selectable: true,
  draggable: false,
  atom: true,

  addAttributes() {
    return {
      messageId: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-message-id"),
        renderHTML: (attrs) => ({ "data-message-id": attrs.messageId }),
      },
      streamId: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-stream-id"),
        renderHTML: (attrs) => ({ "data-stream-id": attrs.streamId }),
      },
      authorName: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-author-name"),
        renderHTML: (attrs) => ({ "data-author-name": attrs.authorName }),
      },
      authorId: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-author-id"),
        renderHTML: (attrs) => ({ "data-author-id": attrs.authorId }),
      },
      actorType: {
        default: "user",
        parseHTML: (element) => element.getAttribute("data-actor-type"),
        renderHTML: (attrs) => ({ "data-actor-type": attrs.actorType }),
      },
      snippet: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-snippet"),
        renderHTML: (attrs) => ({ "data-snippet": attrs.snippet }),
      },
      ...referencePinAttributes,
    }
  },

  parseHTML() {
    return [{ tag: 'div[data-type="quote-reply"]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-type": "quote-reply" })]
  },

  renderText({ node }) {
    const attrs = node.attrs as QuoteReplyAttrs
    return `> ${attrs.snippet}\n> — ${attrs.authorName}\n`
  },

  addNodeView() {
    return ReactNodeViewRenderer(QuoteReplyView)
  },

  addKeyboardShortcuts() {
    return {
      Enter: () => insertParagraphAtGapCursor(this.editor),
      "Shift-Enter": () => insertParagraphAtGapCursor(this.editor),
    }
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("quoteReplyGapCursorPosition"),
        props: {
          handleTextInput: (_view, _from, _to, text) => insertParagraphAtGapCursor(this.editor, text),
          handleClickOn: (_view, _pos, node, nodePos, event, direct) =>
            handleQuoteReplyClick(this.editor, node, nodePos, event, direct),
          handleKeyDown: (_view, event) => {
            if (event.key === "ArrowLeft") {
              return moveAcrossQuoteReply(this.editor, "left")
            }

            if (event.key === "ArrowRight") {
              return moveAcrossQuoteReply(this.editor, "right")
            }

            return false
          },
        },
        view(view) {
          syncGapCursorStyles(view)

          return {
            update(updatedView) {
              syncGapCursorStyles(updatedView)
            },
            destroy() {
              ;(view.dom as HTMLElement).classList.remove("has-after-quote-gapcursor")
            },
          }
        },
      }),
    ]
  },
})
