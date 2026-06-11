import { createContext, useContext, useMemo, type ReactNode } from "react"
import type { ConversationOverlayContext, ConversationRowAnnotation } from "./model"

export interface ConversationOverlayRowState {
  overlay: ConversationOverlayContext
  annotation: ConversationRowAnnotation
}

/**
 * Per-row bridge between the overlay wrapper and the message components it
 * wraps. `ConversationOverlayRow` provides it; deep descendants (the message
 * action menu/drawer in message-event.tsx) read it to offer the
 * "Move to conversation…" correction without threading overlay props through
 * the whole MessageEvent prop chain. Null whenever the overlay is off or the
 * row isn't a decorated message row.
 */
const ConversationOverlayRowContext = createContext<ConversationOverlayRowState | null>(null)

export function ConversationOverlayRowProvider({
  overlay,
  annotation,
  children,
}: ConversationOverlayRowState & { children: ReactNode }) {
  const value = useMemo(() => ({ overlay, annotation }), [overlay, annotation])
  return <ConversationOverlayRowContext.Provider value={value}>{children}</ConversationOverlayRowContext.Provider>
}

export function useConversationOverlayRow(): ConversationOverlayRowState | null {
  return useContext(ConversationOverlayRowContext)
}
