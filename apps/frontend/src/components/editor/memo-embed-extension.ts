import { Node, mergeAttributes } from "@tiptap/core"
import { ReactNodeViewRenderer } from "@tiptap/react"
import { MemoEmbedView } from "./memo-embed-view"

export interface MemoEmbedAttrs {
  /** The ID of the referenced memo */
  memoId: string
  /** Memo title cached at insert time so the chip renders before hydration */
  title: string
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    memoEmbed: {
      /** Insert an inline memo-embed chip for the given memo. */
      insertMemoEmbed: (attrs: { memoId: string; title?: string }) => ReturnType
    }
  }
}

/**
 * Inline atom node that references a memo in the workspace memory. Renders as a
 * compact chip in the composer; the hydrated preview card renders below the
 * sent message (`MemoPreviewList`), mirroring how link previews behave. The
 * chip body is hydrated at render time from the memo detail API (live title);
 * the cached `title` is the pre-hydration label. Mirrors the inline-atom shape
 * of `AttachmentReferenceExtension`.
 */
export const MemoEmbedExtension = Node.create({
  name: "memoEmbed",
  group: "inline",
  inline: true,
  selectable: false,
  atom: true,
  marks: "_", // Allow all marks (bold, italic, etc.)

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
    return [{ tag: 'span[data-type="memo-embed"]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes, { "data-type": "memo-embed" })]
  },

  renderText({ node }) {
    const attrs = node.attrs as MemoEmbedAttrs
    return attrs.title || "Memo"
  },

  addCommands() {
    return {
      insertMemoEmbed:
        (attrs) =>
        ({ chain, state }) => {
          // Preserve marks at the caret so a chip inserted mid-styled-run keeps
          // the surrounding formatting, then drop a trailing space so the caret
          // lands after the chip and any active suggestion match clears.
          const { $from } = state.selection
          const currentMarks = state.storedMarks ?? $from.marks()
          const marks = currentMarks.map((mark) => ({ type: mark.type.name, attrs: mark.attrs }))
          return chain()
            .insertContent([
              { type: this.name, attrs: { memoId: attrs.memoId, title: attrs.title ?? "" }, marks },
              { type: "text", text: " ", marks },
            ])
            .run()
        },
    }
  },

  addNodeView() {
    return ReactNodeViewRenderer(MemoEmbedView)
  },
})
