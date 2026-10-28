import { DocEmbedNode } from "@threahq/prosemirror/schema"
import { ReactNodeViewRenderer } from "@tiptap/react"
import { DocEmbedView } from "./doc-embed-view"

export interface DocEmbedAttrs {
  docId: string
  /** A block in the target doc the pointer lands on; not this node's own id. */
  blockId: string | null
  /** Doc title cached at insert time so the chip renders before the store resolves. */
  title: string
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    docEmbed: {
      /** Insert an inline doc chip at the caret, or at `at` with the caret left where it is. */
      insertDocEmbed: (attrs: { docId: string; blockId?: string | null; title?: string; at?: number }) => ReturnType
    }
  }
}

/** Inline atom pointing at a doc (optionally one of its blocks), rendered as a chip with the doc's live title. */
export const DocEmbedExtension = DocEmbedNode.extend({
  addCommands() {
    return {
      insertDocEmbed:
        (attrs) =>
        ({ chain, state }) => {
          // Keep the caret's marks on the chip and its trailing space, which also ends any open suggestion match.
          const sourceMarks =
            attrs.at === undefined
              ? (state.storedMarks ?? state.selection.$from.marks())
              : state.doc.resolve(attrs.at).marks()
          const marks = sourceMarks.map((mark) => ({ type: mark.type.name, attrs: mark.attrs }))
          const content = [
            {
              type: this.name,
              attrs: { docId: attrs.docId, blockId: attrs.blockId ?? null, title: attrs.title ?? "" },
              marks,
            },
            { type: "text", text: " ", marks },
          ]
          return attrs.at === undefined
            ? chain().insertContent(content).run()
            : chain().insertContentAt(attrs.at, content).run()
        },
    }
  },

  addNodeView() {
    return ReactNodeViewRenderer(DocEmbedView)
  },
})
