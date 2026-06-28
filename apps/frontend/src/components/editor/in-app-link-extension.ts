import { Node, mergeAttributes } from "@tiptap/core"
import { ReactNodeViewRenderer } from "@tiptap/react"
import { InAppLinkView } from "./in-app-link-view"

export interface InAppLinkAttrs {
  /** Canonical in-app URL of the referenced stream or message. */
  url: string
  /** Target stream id, parsed from the URL — the name-resolution key. */
  streamId: string
  /** Target message id when the link points at a message, else null. */
  messageId: string | null
  /** Resolved name cached at insert time so the chip renders before hydration. */
  name: string
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    inAppLink: {
      /** Insert an inline chip for an in-app stream/message link. */
      insertInAppLink: (attrs: {
        url: string
        streamId: string
        messageId?: string | null
        name?: string
      }) => ReturnType
    }
  }
}

/**
 * Inline atom node that replaces an in-app stream/message URL with a compact
 * chip (the name instead of a raw link). Mirrors the inline-atom shape of
 * `MemoEmbedExtension`. The wire format stays a normal markdown link
 * `[name](url)` (see `serializeToMarkdown`) so external/API consumers get a real
 * navigable URL and the timeline renders the same chip from the link alone —
 * the node is purely the compose-time representation. The cached `name` is the
 * pre-hydration label; the node-view resolves the live name and stamps it back.
 */
export const InAppLinkExtension = Node.create({
  name: "inAppLink",
  group: "inline",
  inline: true,
  selectable: false,
  atom: true,
  marks: "_",

  addAttributes() {
    return {
      url: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-url"),
        renderHTML: (attrs) => ({ "data-url": attrs.url }),
      },
      streamId: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-stream-id"),
        renderHTML: (attrs) => ({ "data-stream-id": attrs.streamId }),
      },
      messageId: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-message-id"),
        renderHTML: (attrs) => (attrs.messageId ? { "data-message-id": attrs.messageId } : {}),
      },
      name: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-name"),
        renderHTML: (attrs) => ({ "data-name": attrs.name }),
      },
    }
  },

  parseHTML() {
    return [{ tag: 'span[data-type="in-app-link"]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes, { "data-type": "in-app-link" })]
  },

  renderText({ node }) {
    const attrs = node.attrs as InAppLinkAttrs
    return attrs.name || "Link"
  },

  addCommands() {
    return {
      insertInAppLink:
        (attrs) =>
        ({ chain, state }) => {
          // Preserve marks at the caret and drop a trailing space so the caret
          // lands after the chip and any active suggestion clears — same shape
          // as the memo-embed insert.
          const { $from } = state.selection
          const currentMarks = state.storedMarks ?? $from.marks()
          const marks = currentMarks.map((mark) => ({ type: mark.type.name, attrs: mark.attrs }))
          return chain()
            .insertContent([
              {
                type: this.name,
                attrs: {
                  url: attrs.url,
                  streamId: attrs.streamId,
                  messageId: attrs.messageId ?? null,
                  name: attrs.name ?? "",
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
    return ReactNodeViewRenderer(InAppLinkView)
  },
})
