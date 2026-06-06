import { Node, mergeAttributes } from "@tiptap/core"
import { ReactNodeViewRenderer } from "@tiptap/react"
import { GiphyEmbedView } from "./giphy-embed-view"

export interface GiphyEmbedAttrs {
  /** Giphy CDN URL of the rendition to display. */
  giphyUrl: string
  /** Cached Giphy title; cosmetic fallback label. */
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

/** Coerce a `data-*` attribute to a positive integer, or null when absent/invalid. */
function parseDimensionAttr(raw: string | null): number | null {
  if (raw === null) return null
  const value = Number(raw)
  return Number.isInteger(value) && value > 0 ? value : null
}

/**
 * Inline atom node that embeds a Giphy GIF by CDN URL — the GIF is served from
 * Giphy (not copied into our storage), matching how Giphy intends embeds to
 * work. Mirrors the inline-atom shape of `MemoEmbedExtension`; the node view
 * renders the live `<img>`.
 */
export const GiphyEmbedExtension = Node.create({
  name: "giphyEmbed",
  group: "inline",
  inline: true,
  selectable: false,
  atom: true,
  marks: "_",

  addAttributes() {
    return {
      giphyUrl: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-giphy-url"),
        renderHTML: (attrs) => ({ "data-giphy-url": attrs.giphyUrl }),
      },
      title: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-title"),
        renderHTML: (attrs) => ({ "data-title": attrs.title }),
      },
      width: {
        default: null,
        parseHTML: (element) => parseDimensionAttr(element.getAttribute("data-width")),
        renderHTML: (attrs) => (attrs.width ? { "data-width": String(attrs.width) } : {}),
      },
      height: {
        default: null,
        parseHTML: (element) => parseDimensionAttr(element.getAttribute("data-height")),
        renderHTML: (attrs) => (attrs.height ? { "data-height": String(attrs.height) } : {}),
      },
    }
  },

  parseHTML() {
    return [{ tag: 'span[data-type="giphy-embed"]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes, { "data-type": "giphy-embed" })]
  },

  renderText({ node }) {
    const attrs = node.attrs as GiphyEmbedAttrs
    return attrs.title || "GIF"
  },

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
