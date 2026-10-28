/** A request older than this was made by a gesture that never opened its doc, so it no longer applies. */
export const BLOCK_FOCUS_TTL_MS = 10_000

/** The block a doc should land on when it next opens, keyed by doc; set by the gesture that opens it. */
const pendingBlocks = new Map<string, { blockId: string; requestedAt: number }>()
const listeners = new Map<string, Set<(blockId: string) => void>>()

export function requestBlockFocus(docId: string, blockId: string): void {
  pendingBlocks.set(docId, { blockId, requestedAt: Date.now() })
  const docListeners = listeners.get(docId)
  if (!docListeners?.size) return
  const taken = takeBlockFocus(docId)
  if (taken) docListeners.forEach((listener) => listener(taken))
}

/** Hands an open doc each request aimed at it, taking the request so it lands once. */
export function subscribeBlockFocus(docId: string, listener: (blockId: string) => void): () => void {
  const docListeners = listeners.get(docId) ?? new Set()
  docListeners.add(listener)
  listeners.set(docId, docListeners)
  return () => {
    docListeners.delete(listener)
    if (docListeners.size === 0) listeners.delete(docId)
  }
}

/** The block requested for this doc in the last `BLOCK_FOCUS_TTL_MS`, if any, cleared so it lands once. */
export function takeBlockFocus(docId: string): string | null {
  const pending = pendingBlocks.get(docId)
  pendingBlocks.delete(docId)
  if (!pending || Date.now() - pending.requestedAt > BLOCK_FOCUS_TTL_MS) return null
  return pending.blockId
}
