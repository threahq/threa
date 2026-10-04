import { workspaceScopedKey } from "@/lib/workspace-scoped-key"

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
export function queueSnippetRequest(workspaceId: string, streamId: string): void {
  const key = workspaceScopedKey(workspaceId, streamId)
  cache.set(key, Date.now() + HANDOFF_TTL_MS)
  const subs = listeners.get(key)
  if (subs) {
    for (const listener of subs) listener()
  }
}

/** Read + clear a pending snippet request for the stream (respecting the TTL). */
export function consumeSnippetRequest(workspaceId: string, streamId: string): boolean {
  const key = workspaceScopedKey(workspaceId, streamId)
  const expiresAt = cache.get(key)
  if (expiresAt === undefined) return false
  cache.delete(key)
  return expiresAt >= Date.now()
}

/**
 * Subscribe to snippet-request events for a stream. Returns an unsubscribe
 * function. Mounted composers pair this with an on-mount {@link consumeSnippetRequest}
 * read so they catch requests queued before they subscribed.
 */
export function subscribeSnippetRequest(workspaceId: string, streamId: string, listener: () => void): () => void {
  const key = workspaceScopedKey(workspaceId, streamId)
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
export function resetSnippetRequestStoreCache(): void {
  cache.clear()
  listeners.clear()
}
