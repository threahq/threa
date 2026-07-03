import { createContext, useContext, useCallback, useMemo, useRef } from "react"
import type { ReactNode } from "react"

export interface ConversationReplyData {
  conversationId: string
}

interface ConversationReplyContextValue {
  /** Arm the composer with a conversation to file the next send into — called by message actions */
  triggerReplyInConversation: (data: ConversationReplyData) => void
  /** Register the composer's handler */
  registerHandler: (handler: (data: ConversationReplyData) => void) => () => void
}

const ConversationReplyCtx = createContext<ConversationReplyContextValue | null>(null)

/**
 * Relays "Reply in conversation" from a message row to the stream composer
 * (mirrors QuoteReplyProvider). Unlike quote reply, nothing is inserted into
 * the body: the composer holds the conversation as a pending send directive
 * (`{ intent: "existing" }`) and shows a dismissible strip, so the next send
 * files into the conversation and its provenance chip renders instantly.
 */
export function ConversationReplyProvider({ children }: { children: ReactNode }) {
  const handlerRef = useRef<((data: ConversationReplyData) => void) | null>(null)

  const registerHandler = useCallback((handler: (data: ConversationReplyData) => void) => {
    handlerRef.current = handler
    return () => {
      handlerRef.current = null
    }
  }, [])

  const triggerReplyInConversation = useCallback((data: ConversationReplyData) => {
    handlerRef.current?.(data)
  }, [])

  const value = useMemo(
    () => ({ triggerReplyInConversation, registerHandler }),
    [triggerReplyInConversation, registerHandler]
  )

  return <ConversationReplyCtx.Provider value={value}>{children}</ConversationReplyCtx.Provider>
}

export function useConversationReply(): ConversationReplyContextValue | null {
  return useContext(ConversationReplyCtx)
}
