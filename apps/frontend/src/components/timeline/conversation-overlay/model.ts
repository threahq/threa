import type { ConversationWithStaleness } from "@threa/types"

/** Number of hues in the `--conversation-N` CSS palette (index.css). */
export const CONVERSATION_COLOR_COUNT = 8

/**
 * CSS color for a conversation's palette slot. `colorIndex` is the stable
 * index from `ConversationOverlayModel.colorIndexById`; `alpha` composes
 * washes/rails/borders from the same hue.
 */
export function conversationColor(colorIndex: number, alpha?: number): string {
  const channels = `var(--conversation-${(colorIndex % CONVERSATION_COLOR_COUNT) + 1})`
  return alpha != null ? `hsl(${channels} / ${alpha})` : `hsl(${channels})`
}

export interface ConversationOverlayModel {
  /** Conversations of this stream, oldest first (color + legend order). */
  conversations: ConversationWithStaleness[]
  conversationsById: Map<string, ConversationWithStaleness>
  colorIndexById: Map<string, number>
  /** Reverse index over primary membership (`messageIds`) only. */
  conversationIdByMessageId: Map<string, string>
}

/**
 * Build the overlay's lookup model from the stream's conversation list.
 *
 * Ordering is by `createdAt` ascending (id as tiebreak) so palette
 * assignment is stable while the overlay is open: new conversations append
 * and take the next hue; existing ones never recolor when the list reorders
 * by activity. Conversations from child threads (which
 * `listByStream` includes) are dropped — their messages live in thread
 * streams, not in this timeline.
 */
export function buildConversationOverlayModel(
  conversations: ConversationWithStaleness[],
  streamId: string
): ConversationOverlayModel {
  const ordered = conversations
    .filter((c) => c.streamId === streamId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))

  const conversationsById = new Map<string, ConversationWithStaleness>()
  const colorIndexById = new Map<string, number>()
  const conversationIdByMessageId = new Map<string, string>()
  ordered.forEach((conversation, index) => {
    conversationsById.set(conversation.id, conversation)
    colorIndexById.set(conversation.id, index % CONVERSATION_COLOR_COUNT)
    for (const messageId of conversation.messageIds) {
      conversationIdByMessageId.set(messageId, conversation.id)
    }
  })

  return { conversations: ordered, conversationsById, colorIndexById, conversationIdByMessageId }
}

/**
 * Per-row annotation stamped onto message timeline items while the overlay
 * is active (see `annotateConversationRows` in event-list.tsx).
 */
export interface ConversationRowAnnotation {
  /** Primary conversation, or null when extraction hasn't assigned one yet. */
  conversationId: string | null
  /**
   * True on the first message of a contiguous run of the same conversation —
   * where the floating topic chip renders. Always false for unassigned rows.
   */
  blockStart: boolean
}

/** Shared overlay state threaded through `TimelineItemRenderContext`. */
export interface ConversationOverlayContext {
  model: ConversationOverlayModel
  /** Conversation being focused via the in-view panel; others dim. */
  focusedConversationId: string | null
  onToggleFocus: (conversationId: string) => void
  /** User correction: move a message's primary membership. */
  onReassignMessage: (messageId: string, toConversationId: string) => void
  /**
   * messageIds with an in-flight correction, for pending affordance state.
   * A set rather than the latest mutation's variables: two rapid corrections
   * on different messages each keep their own pending affordance.
   */
  pendingMessageIds: ReadonlySet<string>
  /**
   * Viewport tracking for the in-view panel: rows register their DOM node +
   * conversation on mount and return the IntersectionObserver cleanup (React
   * 19 ref-callback cleanup). Stable identity — observing does not re-render
   * timeline rows.
   */
  observeRow: (element: HTMLElement, conversationId: string) => () => void
}
