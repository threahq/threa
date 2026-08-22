import { Node, mergeAttributes } from "@tiptap/core"
import { ReactNodeViewRenderer } from "@tiptap/react"
import type { ContentRange } from "@threa/types"
import { SharedMessageView } from "./shared-message-view"
import { referencePinAttributes } from "./reference-attributes"

export interface SharedMessageAttrs {
  /** The ID of the referenced source message */
  messageId: string
  /** The stream containing the referenced message (for backend access validation) */
  streamId: string
  /** Display name of the source author, cached so the node can render before hydration completes */
  authorName: string
  /** The ID of the source author, cached for the same reason */
  authorId: string
  /** The actor type of the source author, cached for the same reason */
  actorType: string
  /**
   * The conversation this message was shared from, set only when the share
   * originated on a conversation surface (board card / conversation panel). When
   * present the rendered pointer card's back-link reopens the source in that
   * conversation's side panel instead of its home-stream permalink; in-stream
   * shares leave it undefined and the card links to the stream permalink.
   */
  conversationId?: string
  /** Source message revision this share is pinned to; null = unpinned */
  version: number | null
  /** Span inside the pinned version; null = the whole message */
  range: ContentRange | null
}

/**
 * Atomic block node that references a message in another stream. The body is
 * hydrated at render time from the canonical `slots` map returned alongside the
 * stream's events (this node is slot type #1, keyed by its reference pin —
 * `sharedMessageSlotKey(messageId, version, range)`).
 * Updates to the source message propagate automatically on the next fetch; the
 * `pointer:invalidated` realtime event triggers a refetch so live edits surface
 * without page reload.
 */
export const SharedMessageExtension = Node.create({
  name: "sharedMessage",
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
      conversationId: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-conversation-id"),
        // Omit the attribute entirely when there's no conversation origin so an
        // in-stream share's HTML/markdown stays the legacy two-segment shape.
        renderHTML: (attrs) => (attrs.conversationId ? { "data-conversation-id": attrs.conversationId } : {}),
      },
      ...referencePinAttributes,
    }
  },

  parseHTML() {
    return [{ tag: 'div[data-type="shared-message"]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-type": "shared-message" })]
  },

  renderText({ node }) {
    const attrs = node.attrs as SharedMessageAttrs
    return `[shared message ${attrs.messageId}]\n`
  },

  addNodeView() {
    return ReactNodeViewRenderer(SharedMessageView)
  },
})
