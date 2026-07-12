import { useSyncExternalStore } from "react"

// Which board conversation is playing its one-shot gold-thread post flash (the
// viewer's own just-posted card). Held in a module store rather than board-page
// state so only the one card whose flashed-ness flips re-renders: feeding it
// through the page's row-element memo would rebuild every mounted card twice per
// post (set + clear), the exact regression that memo exists to prevent.

let flashConversationId: string | null = null
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

/** Flash a conversation's card, or clear the flash with `null`. */
export function setBoardFlash(conversationId: string | null): void {
  if (flashConversationId === conversationId) return
  flashConversationId = conversationId
  emit()
}

export function resetBoardFlashStoreCache(): void {
  if (flashConversationId === null) return
  flashConversationId = null
  emit()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** True while this conversation's card is playing its post flash. */
export function useBoardFlash(conversationId: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => flashConversationId === conversationId,
    () => false
  )
}
