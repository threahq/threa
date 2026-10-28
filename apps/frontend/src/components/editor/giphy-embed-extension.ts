import { GiphyEmbedNode } from "@threahq/prosemirror/schema"
import { ReactNodeViewRenderer } from "@tiptap/react"
import { GiphyEmbedView } from "./giphy-embed-view"

export interface GiphyEmbedAttrs {
  /** Giphy CDN URL of the rendition to display. */
  giphyUrl: string
  title: string
  /** Intrinsic pixel size of the rendition, so the renderer reserves an
   *  aspect-ratio box before the GIF loads (no layout shift). */
  width: number | null
  height: number | null
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    giphyEmbed: {
      /** Insert an inline GIF embed rendered straight from Giphy's CDN. */
      insertGiphyEmbed: (attrs: { giphyUrl: string; title?: string; width?: number; height?: number }) => ReturnType
    }
  }
}

/**
 * Inline atom node that embeds a Giphy GIF by CDN URL — the GIF is served from
 * Giphy (not copied into our storage), matching how Giphy intends embeds to
 * work. The node view renders the live `<img>`.
 */
export const GiphyEmbedExtension = GiphyEmbedNode.extend({
  addCommands() {
    return {
      insertGiphyEmbed:
        (attrs) =>
        ({ chain, state }) => {
          // Preserve marks at the caret and drop a trailing space so the caret
          // lands after the embed and any active slash match clears — same shape
          // as the memo-embed insert.
          const { $from } = state.selection
          const currentMarks = state.storedMarks ?? $from.marks()
          const marks = currentMarks.map((mark) => ({ type: mark.type.name, attrs: mark.attrs }))
          return chain()
            .insertContent([
              {
                type: this.name,
                attrs: {
                  giphyUrl: attrs.giphyUrl,
                  title: attrs.title ?? "",
                  width: attrs.width ?? null,
                  height: attrs.height ?? null,
                },
                marks,
              },
              { type: "text", text: " ", marks },
            ])
            .run()
        },
    }
  },

  addNodeView() {
    return ReactNodeViewRenderer(GiphyEmbedView)
  },
})
