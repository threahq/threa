import { createContext, useContext, type ReactNode } from "react"

/**
 * Primary message→conversation membership for the current stream, provided
 * regardless of whether the conversation overlay is painting. Powers the
 * per-message "Show in conversation" action (open the conversation in the side
 * panel) without requiring the user to first turn the overlay on. Built from
 * the same `buildConversationOverlayModel` membership the overlay uses, so the
 * two never disagree about which conversation owns a message.
 */
const MessageConversationContext = createContext<ReadonlyMap<string, string> | null>(null)

export function MessageConversationProvider({
  conversationIdByMessageId,
  children,
}: {
  conversationIdByMessageId: ReadonlyMap<string, string>
  children: ReactNode
}) {
  return (
    <MessageConversationContext.Provider value={conversationIdByMessageId}>
      {children}
    </MessageConversationContext.Provider>
  )
}

/**
 * The primary conversation id for a message in the current stream, or null when
 * none is known — the message belongs to no conversation, or the stream's
 * conversation list hasn't loaded (e.g. a thread, where membership resolves
 * through the root and isn't surfaced here).
 */
export function useMessageConversationId(messageId: string): string | null {
  const map = useContext(MessageConversationContext)
  return map?.get(messageId) ?? null
}
