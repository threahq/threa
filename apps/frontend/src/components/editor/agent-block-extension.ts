import { Node, mergeAttributes } from "@tiptap/core"
import { ReactNodeViewRenderer } from "@tiptap/react"
import { AgentBlockView } from "./agent-block-view"

export interface AgentBlockAttrs {
  /** `persona_…` / `bot_…` — the agent credited with the text (INV-64). */
  authorId: string
  /** Display name at insertion time (denormalized). */
  authorName: string
  /** The aside the text was drafted in, when it came from one. */
  sourceAsideId: string | null
}

/**
 * Text an agent wrote, carried into a human's message. The body stays editable
 * — attribution is about provenance, not immutability — and `defining` keeps
 * the node (and its attrs) around edits that replace its content, so a rewrite
 * inside the frame can't silently launder agent text into unattributed text.
 */
export const AgentBlockExtension = Node.create({
  name: "agentBlock",
  group: "block",
  content: "block+",
  defining: true,
  draggable: false,

  addAttributes() {
    return {
      authorId: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-author-id"),
        renderHTML: (attrs) => ({ "data-author-id": attrs.authorId }),
      },
      authorName: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-author-name"),
        renderHTML: (attrs) => ({ "data-author-name": attrs.authorName }),
      },
      sourceAsideId: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-source-aside-id"),
        renderHTML: (attrs) => (attrs.sourceAsideId ? { "data-source-aside-id": attrs.sourceAsideId } : {}),
      },
    }
  },

  parseHTML() {
    return [{ tag: 'div[data-type="agent-block"]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-type": "agent-block" }), 0]
  },

  addNodeView() {
    return ReactNodeViewRenderer(AgentBlockView)
  },
})
