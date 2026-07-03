/**
 * Ephemeral per-conversation signal asking a conversation side panel to open its
 * reply composer as soon as it mounts. "Reply in conversation" fires from a
 * message row (in the stream-content tree) but the reply lands in the conversation
 * panel (a separate React tree in the panel slot), so the row queues a request
 * here keyed by conversation id and the mounted panel picks it up — the same
 * hand-off shape used for snippet requests and share nodes. Content-less: the
 * panel just opens its already-scoped {@link BoardReplyComposer} and focuses it.
 */

const HANDOFF_TTL_MS = 30 * 1000

const cache = new Map<string, number>()
const listeners = new Map<string, Set<() => void>>()

/**
 * Ask the conversation panel for `conversationId` to open its reply composer. A
 * panel already mounted for this conversation is notified immediately; otherwise
 * the request waits (briefly) to be consumed on the panel's next mount.
 */
export function requestConversationReplyOpen(conversationId: string): void {
  cache.set(conversationId, Date.now() + HANDOFF_TTL_MS)
  const subs = listeners.get(conversationId)
  if (subs) {
    for (const listener of subs) listener()
  }
}

/** Read + clear a pending reply-open request for the conversation (respecting the TTL). */
export function consumeConversationReplyOpen(conversationId: string): boolean {
  const expiresAt = cache.get(conversationId)
  if (expiresAt === undefined) return false
  cache.delete(conversationId)
  return expiresAt >= Date.now()
}

/**
 * Subscribe to reply-open events for a conversation. Returns an unsubscribe
 * function. A mounted panel pairs this with an on-mount
 * {@link consumeConversationReplyOpen} read so it catches a request queued before
 * it subscribed, and reacts to one that arrives while it's already open.
 */
export function subscribeConversationReplyOpen(conversationId: string, listener: () => void): () => void {
  let subs = listeners.get(conversationId)
  if (!subs) {
    subs = new Set()
    listeners.set(conversationId, subs)
  }
  subs.add(listener)
  return () => {
    const set = listeners.get(conversationId)
    if (!set) return
    set.delete(listener)
    if (set.size === 0) listeners.delete(conversationId)
  }
}

/**
 * Clears every queued request and subscriber. Module-level cache survives an
 * account-switch remount, so AccountScope clears it on switch.
 */
export function resetConversationReplyOpenStoreCache(): void {
  cache.clear()
  listeners.clear()
}
