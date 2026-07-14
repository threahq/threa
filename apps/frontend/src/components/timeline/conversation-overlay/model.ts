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
 * Map every message id in `conversations` to the conversation it belongs to,
 * for the "Show in conversation" action. Unlike {@link buildConversationOverlayModel}
 * (which colors one stream's own conversations by PRIMARY membership), this:
 *
 * - includes `secondaryMessageIds` — a reply that joined a conversation as a
 *   cross-stream member (e.g. a thread reply off a root opener) is mapped too;
 * - does NOT filter by `streamId` — a conversation spans its root and the root's
 *   threads (one root), and message ids are globally unique, so any message
 *   rendered in the current stream resolves regardless of the conversation's
 *   anchor.
 *
 * Primary membership wins when an id appears in both lists (it's the message's
 * canonical home), so secondaries are written first and overwritten by primaries.
 */
export function buildMessageConversationMap(conversations: ConversationWithStaleness[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const conversation of conversations) {
    for (const messageId of conversation.secondaryMessageIds) map.set(messageId, conversation.id)
  }
  for (const conversation of conversations) {
    for (const messageId of conversation.messageIds) map.set(messageId, conversation.id)
  }
  return map
}

/**
 * A topic revival: a message that reopens a conversation whose previous member
 * message is not the immediately-preceding timeline row (scattered / old), so
 * in the flat timeline it reads as a non-sequitur. Drives the on-message
 * provenance chip ("↪ continues Pizza · 3h ago") that links to the
 * conversation panel. Computed always-on for channels/DMs (independent of the
 * overlay) by `annotateConversationRevivals` in event-list.tsx.
 */
export interface ConversationRevival {
  /** Conversation to open when the chip is tapped (`conv:<id>` panel). */
  conversationId: string
  /** Topic label for the chip; null falls back to a generic label. */
  topicSummary: string | null
  /**
   * `createdAt` of the conversation's previous member row — the "· 3h ago"
   * anchor. The prior activity of this topic, not this reviving message.
   * `undefined` when that member isn't locally loaded (a block start whose
   * conversation we simply haven't rendered before in this window — the chip
   * still fires, per the "context, not just dormant-revival" call below; it
   * just omits the time it can't know) — the chip renders without the tail.
   */
  previousActivityAt?: string
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
  /**
   * User correction: move a message's primary membership to an existing
   * conversation, or to a freshly minted one when `toConversationId` is null.
   */
  onReassignMessage: (messageId: string, toConversationId: string | null) => void
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
