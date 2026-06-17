/**
 * Ephemeral per-stream signal asking the stream's composer to open the snippet
 * editor. The command palette lives in a separate React tree from the composer,
 * so it queues a request here (keyed by stream id) and the mounted composer
 * picks it up via {@link subscribeSnippetRequest} — the same hand-off shape used
 * for share nodes. Content-less: the editor seeds an empty snippet itself.
 */

const HANDOFF_TTL_MS = 30 * 1000

const cache = new Map<string, number>()
const listeners = new Map<string, Set<() => void>>()

/**
 * Ask the composer for `streamId` to open the snippet editor. A composer already
 * mounted is notified immediately; otherwise the request waits (briefly) to be
 * consumed on the composer's next mount.
 */
export function queueSnippetRequest(streamId: string): void {
  cache.set(streamId, Date.now() + HANDOFF_TTL_MS)
  const subs = listeners.get(streamId)
  if (subs) {
    for (const listener of subs) listener()
  }
}

/** Read + clear a pending snippet request for the stream (respecting the TTL). */
export function consumeSnippetRequest(streamId: string): boolean {
  const expiresAt = cache.get(streamId)
  if (expiresAt === undefined) return false
  cache.delete(streamId)
  return expiresAt >= Date.now()
}

/**
 * Subscribe to snippet-request events for a stream. Returns an unsubscribe
 * function. Mounted composers pair this with an on-mount {@link consumeSnippetRequest}
 * read so they catch requests queued before they subscribed.
 */
export function subscribeSnippetRequest(streamId: string, listener: () => void): () => void {
  let subs = listeners.get(streamId)
  if (!subs) {
    subs = new Set()
    listeners.set(streamId, subs)
  }
  subs.add(listener)
  return () => {
    const set = listeners.get(streamId)
    if (!set) return
    set.delete(listener)
    if (set.size === 0) listeners.delete(streamId)
  }
}

/**
 * Clears every queued request and subscriber. Module-level cache survives an
 * account-switch remount, so AccountScope clears it on switch.
 */
export function resetSnippetRequestStoreCache(): void {
  cache.clear()
  listeners.clear()
}
