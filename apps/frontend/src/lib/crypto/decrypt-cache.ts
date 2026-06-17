import { tryDecryptMessagePayload, type DecryptedMessageContent, type DecryptMessageOpts } from "./message-envelope"
import { createDecryptedCache, type DecryptStatus } from "./decrypted-cache"

/**
 * In-memory cache for decrypted E2E message payloads — a per-key instance of the
 * shared {@link createDecryptedCache} primitive (which owns the inflight-dedup,
 * lock-epoch guard, subscribe/version signal, LRU, and lock-clear registration).
 *
 * Ciphertext + envelope stay at rest in `db.events.payload` and decrypt only on
 * demand at render time. Each rendered message hits this cache; on miss, the
 * caller kicks off a decrypt and the cache notifies subscribers when it lands.
 * `clearDecryptCache()` (also fired by `clearAllDecrypted` on lock) drops
 * everything so plaintext never outlives the unlocked session.
 */

export type { DecryptStatus }

export interface DecryptCacheEntry {
  status: DecryptStatus
  content: DecryptedMessageContent | null
}

const cache = createDecryptedCache<DecryptCacheEntry>({
  subscription: "per-key",
  // LRU caps memory regardless of how many messages the user scrolls.
  lru: 500,
  // A message id is immutable: a decrypt that fails (wrong recipient, tampered
  // AAD) is terminal, so a re-request must not retry.
  retryFailed: false,
  pending: () => ({ status: "pending", content: null }),
  // A message id's first good decrypt is final, so a later seed must not clobber it.
  skipPrime: (existing) => existing?.status === "decrypted",
})

/** Snapshot of the global cache version — changes on any insert/seed/invalidate/clear. */
export function getDecryptCacheVersion(): number {
  return cache.getVersion()
}

/** Subscribe to ANY cache change (for batch readers like draft-preview lists). */
export function subscribeDecryptCacheVersion(listener: () => void): () => void {
  return cache.subscribe(null, listener)
}

export function getCachedDecryption(eventId: string): DecryptCacheEntry | undefined {
  return cache.peek(eventId)
}

export function subscribeToDecryption(eventId: string, listener: () => void): () => void {
  return cache.subscribe(eventId, listener)
}

export interface RequestDecryptionInput {
  contentMarkdown: string
  envelope: unknown
  /** Base64 ciphertext — required for v2 SSK messages where it lives off-envelope. */
  ciphertext?: string
}

export function requestDecryption(
  eventId: string,
  payload: RequestDecryptionInput,
  opts: DecryptMessageOpts
): Promise<DecryptCacheEntry> {
  return cache.request(eventId, async () => {
    const decrypted = await tryDecryptMessagePayload(payload, opts)
    return decrypted ? { status: "decrypted", content: decrypted } : { status: "failed", content: null }
  })
}

/**
 * Seed the cache with already-known plaintext for an event id, marking it
 * decrypted without running crypto. Used on send reconciliation: the sender
 * already holds the plaintext it just encrypted, so the incoming server event —
 * which carries only ciphertext — can render its content immediately instead of
 * flashing a "decrypting" placeholder as the optimistic row is swapped for the
 * sent row. No-op if the event already has a decrypted entry.
 */
export function seedDecryption(eventId: string, content: DecryptedMessageContent): void {
  cache.prime(eventId, { status: "decrypted", content })
}

/**
 * Drop the cached (and in-flight) decryption for a single id and notify
 * subscribers. Unlike `clearDecryptCache` (which wipes everything on lock), this
 * targets one id so a caller can REPLACE stale plaintext for a reused id.
 *
 * `seedDecryption` deliberately no-ops when an id already has a decrypted entry
 * (a message's id is immutable, so its first good decrypt is final). A draft id,
 * by contrast, is stable across edits — every keystroke re-seals the SAME id with
 * new plaintext. Without invalidation the second edit's seed would be ignored and
 * the read path would serve the FIRST edit's body on the next remount. The draft
 * write path therefore invalidates this id, then seeds the fresh plaintext.
 */
export function invalidateDecryption(eventId: string): void {
  cache.invalidate(eventId)
}

export function clearDecryptCache(): void {
  cache.clear()
}
