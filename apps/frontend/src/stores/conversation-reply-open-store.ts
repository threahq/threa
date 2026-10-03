import { workspaceScopedKey } from "@/lib/workspace-scoped-key"

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
export function requestConversationReplyOpen(workspaceId: string, conversationId: string): void {
  const key = workspaceScopedKey(workspaceId, conversationId)
  cache.set(key, Date.now() + HANDOFF_TTL_MS)
  const subs = listeners.get(key)
  if (subs) {
    for (const listener of subs) listener()
  }
}

/** Read + clear a pending reply-open request for the conversation (respecting the TTL). */
export function consumeConversationReplyOpen(workspaceId: string, conversationId: string): boolean {
  const key = workspaceScopedKey(workspaceId, conversationId)
  const expiresAt = cache.get(key)
  if (expiresAt === undefined) return false
  cache.delete(key)
  return expiresAt >= Date.now()
}

/**
 * Subscribe to reply-open events for a conversation. Returns an unsubscribe
 * function. A mounted panel pairs this with an on-mount
 * {@link consumeConversationReplyOpen} read so it catches a request queued before
 * it subscribed, and reacts to one that arrives while it's already open.
 */
export function subscribeConversationReplyOpen(
  workspaceId: string,
  conversationId: string,
  listener: () => void
): () => void {
  const key = workspaceScopedKey(workspaceId, conversationId)
  let subs = listeners.get(key)
  if (!subs) {
    subs = new Set()
    listeners.set(key, subs)
  }
  subs.add(listener)
  return () => {
    const set = listeners.get(key)
    if (!set) return
    set.delete(listener)
    if (set.size === 0) listeners.delete(key)
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
