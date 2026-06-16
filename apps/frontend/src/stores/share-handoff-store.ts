import type { SharedMessageAttrs } from "@/components/editor/shared-message-extension"

/**
 * Ephemeral per-stream "hand-off" of a share node from the Share action to the
 * target stream's composer. Scoped to a single navigation hop with a short TTL
 * so stale entries never resurface if the user bails mid-flow.
 */
export interface ShareHandoffEntry {
  attrs: SharedMessageAttrs
  /** Epoch ms expiration; entries past this are ignored + evicted on read */
  expiresAt: number
}

/**
 * Hand-off for a message shared OUT of an E2E scratchpad. A sealed source can't
 * be a pointer (recipients hold no key), so the share is the decrypted plaintext
 * itself — made public as a quote in the target — captured at share time behind
 * an explicit confirmation. `attrs` is carried for author attribution.
 */
export interface PlaintextShareHandoffEntry {
  markdown: string
  attrs: SharedMessageAttrs
  expiresAt: number
}

const HANDOFF_TTL_MS = 5 * 60 * 1000

const cache = new Map<string, ShareHandoffEntry>()
const plaintextCache = new Map<string, PlaintextShareHandoffEntry>()
const listeners = new Map<string, Set<() => void>>()

/**
 * Queue a share node for the target stream's composer. A composer already
 * mounted for the stream is notified via {@link subscribeShareHandoff} so it
 * picks the share up without remounting (e.g. sharing back into the stream the
 * user is already viewing).
 */
export function queueShareHandoff(targetStreamId: string, attrs: SharedMessageAttrs): void {
  cache.set(targetStreamId, {
    attrs,
    expiresAt: Date.now() + HANDOFF_TTL_MS,
  })
  const subs = listeners.get(targetStreamId)
  if (subs) {
    for (const listener of subs) listener()
  }
}

/**
 * Queue a decrypted E2E message to be shared as a public plaintext quote in the
 * target stream's composer. Same hop + TTL + subscriber notification as the
 * pointer hand-off; consumed via {@link consumePlaintextShareHandoff}.
 */
export function queuePlaintextShareHandoff(targetStreamId: string, markdown: string, attrs: SharedMessageAttrs): void {
  plaintextCache.set(targetStreamId, { markdown, attrs, expiresAt: Date.now() + HANDOFF_TTL_MS })
  const subs = listeners.get(targetStreamId)
  if (subs) {
    for (const listener of subs) listener()
  }
}

/** Read + clear a pending plaintext (decrypted E2E) share for the stream. */
export function consumePlaintextShareHandoff(targetStreamId: string): PlaintextShareHandoffEntry | null {
  const entry = plaintextCache.get(targetStreamId)
  if (!entry) return null
  plaintextCache.delete(targetStreamId)
  if (entry.expiresAt < Date.now()) return null
  return entry
}

/**
 * Subscribe to share-handoff events for a given stream. Composers already
 * mounted call this in addition to the on-mount {@link consumeShareHandoff}
 * read so they pick up shares queued while they were live. Returns an
 * unsubscribe function.
 */
export function subscribeShareHandoff(targetStreamId: string, listener: () => void): () => void {
  let subs = listeners.get(targetStreamId)
  if (!subs) {
    subs = new Set()
    listeners.set(targetStreamId, subs)
  }
  subs.add(listener)
  return () => {
    const set = listeners.get(targetStreamId)
    if (!set) return
    set.delete(listener)
    if (set.size === 0) listeners.delete(targetStreamId)
  }
}

/**
 * Read + clear the pending share for the given stream. Returns null when
 * nothing is queued or the entry has expired (and evicts it).
 */
export function consumeShareHandoff(targetStreamId: string): SharedMessageAttrs | null {
  const entry = cache.get(targetStreamId)
  if (!entry) return null
  cache.delete(targetStreamId)
  if (entry.expiresAt < Date.now()) return null
  return entry.attrs
}

/**
 * Non-consuming peek. Returns whether a share is currently queued for the
 * stream. Mostly for tests and debug panels.
 */
export function peekShareHandoff(targetStreamId: string): SharedMessageAttrs | null {
  const entry = cache.get(targetStreamId)
  if (!entry) return null
  if (entry.expiresAt < Date.now()) {
    cache.delete(targetStreamId)
    return null
  }
  return entry.attrs
}

/**
 * Clears every queued handoff and subscriber. The cache is module-level so it
 * survives an account-switch React remount; AccountScope calls this on switch
 * so a share queued under one account never surfaces in another.
 */
export function resetShareHandoffStoreCache(): void {
  cache.clear()
  plaintextCache.clear()
  listeners.clear()
}

/** Clears every queued handoff. Test helper. */
export function __resetShareHandoffStoreForTesting(): void {
  resetShareHandoffStoreCache()
}
