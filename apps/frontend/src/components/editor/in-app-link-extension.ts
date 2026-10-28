import { InAppLinkNode } from "@threahq/prosemirror/schema"
import { ReactNodeViewRenderer } from "@tiptap/react"
import { InAppLinkView } from "./in-app-link-view"

export interface InAppLinkAttrs {
  /** Canonical in-app URL of the referenced stream, message, or conversation. */
  url: string
  /**
   * Target stream id, parsed from the URL — the name-resolution key for
   * stream/message links. Null for a conversation link (it has no `/s/:id`
   * permalink); the node-view resolves a conversation by its URL instead.
   */
  streamId: string | null
  /** Target message id when the link points at a message, else null. */
  messageId: string | null
  /** Resolved name cached at insert time so the chip renders before hydration. */
  name: string
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    inAppLink: {
      /** Insert an inline chip for an in-app stream/message/conversation link. */
      insertInAppLink: (attrs: {
        url: string
        streamId?: string | null
        messageId?: string | null
        name?: string
      }) => ReturnType
    }
  }
}

/**
 * Inline atom node that replaces an in-app stream/message/conversation URL with a
 * compact chip (the name instead of a raw link). The wire format stays a normal markdown link
 * `[name](url)` (see `serializeToMarkdown`) so external/API consumers get a real
 * navigable URL and the timeline renders the same chip from the link alone —
 * the node is purely the compose-time representation. The cached `name` is the
 * pre-hydration label; the node-view resolves the live name and stamps it back.
 */
export const InAppLinkExtension = InAppLinkNode.extend({
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
                  streamId: attrs.streamId ?? null,
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
