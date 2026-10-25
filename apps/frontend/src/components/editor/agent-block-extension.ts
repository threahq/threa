import { AgentBlockNode } from "@threahq/prosemirror/schema"
import { ReactNodeViewRenderer } from "@tiptap/react"
import { AgentBlockView } from "./agent-block-view"

export interface AgentBlockAttrs {
  /** `persona_…` / `bot_…` — the agent credited with the text (INV-64). */
  authorId: string
  /** Display name at insertion time (denormalized). */
  authorName: string
}

/**
 * Text an agent wrote, carried into a human's message. The body stays editable
 * — attribution is about provenance, not immutability.
 */
export const AgentBlockExtension = AgentBlockNode.extend({
  addNodeView() {
    return ReactNodeViewRenderer(AgentBlockView)
  },
})
