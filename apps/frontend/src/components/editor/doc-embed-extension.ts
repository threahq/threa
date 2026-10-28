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
      /** Insert an inline doc chip at the caret. */
      insertDocEmbed: (attrs: { docId: string; blockId?: string | null; title?: string }) => ReturnType
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
          const { $from } = state.selection
          const marks = (state.storedMarks ?? $from.marks()).map((mark) => ({
            type: mark.type.name,
            attrs: mark.attrs,
          }))
          return chain()
            .insertContent([
              {
                type: this.name,
                attrs: { docId: attrs.docId, blockId: attrs.blockId ?? null, title: attrs.title ?? "" },
                marks,
              },
              { type: "text", text: " ", marks },
            ])
            .run()
        },
    }
  },

  addNodeView() {
    return ReactNodeViewRenderer(DocEmbedView)
  },
})
