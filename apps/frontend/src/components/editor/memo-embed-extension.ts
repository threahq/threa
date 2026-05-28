import { Node, mergeAttributes } from "@tiptap/core"
import { ReactNodeViewRenderer } from "@tiptap/react"
import { MemoEmbedView } from "./memo-embed-view"

export interface MemoEmbedAttrs {
  /** The ID of the referenced memo */
  memoId: string
  /** Memo title cached at insert time so the card renders before hydration */
  title: string
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    memoEmbed: {
      /** Insert a memo-embed pointer card for the given memo. */
      insertMemoEmbed: (attrs: { memoId: string; title?: string }) => ReturnType
    }
  }
}

/**
 * Atomic block node that references a memo in the workspace memory. The card
 * body is hydrated at render time from the memo detail API (live title, type,
 * tags). Carries the memo id + a cached title so the card reads sensibly
 * before hydration. Mirrors `SharedMessageExtension`.
 */
export const MemoEmbedExtension = Node.create({
  name: "memoEmbed",
  group: "block",
  selectable: true,
  draggable: false,
  atom: true,

  addAttributes() {
    return {
      memoId: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-memo-id"),
        renderHTML: (attrs) => ({ "data-memo-id": attrs.memoId }),
      },
      title: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-title"),
        renderHTML: (attrs) => ({ "data-title": attrs.title }),
      },
    }
  },

  parseHTML() {
    return [{ tag: 'div[data-type="memo-embed"]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-type": "memo-embed" })]
  },

  renderText({ node }) {
    const attrs = node.attrs as MemoEmbedAttrs
    return `[memo ${attrs.memoId}]\n`
  },

  addCommands() {
    return {
      insertMemoEmbed:
        (attrs) =>
        ({ commands }) =>
          commands.insertContent({
            type: this.name,
            attrs: { memoId: attrs.memoId, title: attrs.title ?? "" },
          }),
    }
  },

  addNodeView() {
    return ReactNodeViewRenderer(MemoEmbedView)
  },
})
