import { tryDecryptMessagePayload, type DecryptedMessageContent, type DecryptMessageOpts } from "./message-envelope"

/**
 * In-memory cache for decrypted E2E message payloads.
 *
 * Phase 3.5 keeps ciphertext + envelope at rest in `db.events.payload` and
 * decrypts only on demand at render time. Each rendered message hits this
 * cache; on miss, the caller kicks off a decrypt and the cache notifies
 * subscribers when it lands.
 *
 * Lifecycle:
 *  - Entries are inserted on successful (or failed) decrypt.
 *  - LRU eviction caps memory regardless of how many messages the user scrolls.
 *  - `clearDecryptCache()` drops everything; call it on session lock and on
 *    account switch so plaintext never outlives the unlocked session.
 */

export type DecryptStatus = "pending" | "decrypted" | "failed"

export interface DecryptCacheEntry {
  status: DecryptStatus
  content: DecryptedMessageContent | null
}

const MAX_ENTRIES = 500

const entries = new Map<string, DecryptCacheEntry>()
const inflight = new Map<string, Promise<DecryptCacheEntry>>()
const listeners = new Map<string, Set<() => void>>()

// Bumped by clearDecryptCache so in-flight decrypts that resolve after a lock
// can detect they're stale and refuse to write plaintext back into the cache.
let generation = 0

function emit(eventId: string): void {
  const set = listeners.get(eventId)
  if (!set) return
  for (const listener of set) listener()
}

function touch(eventId: string, entry: DecryptCacheEntry): void {
  // Map iteration order is insertion order; re-inserting bumps it to MRU.
  entries.delete(eventId)
  entries.set(eventId, entry)
  if (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next().value
    if (oldest !== undefined) entries.delete(oldest)
  }
}

export function getCachedDecryption(eventId: string): DecryptCacheEntry | undefined {
  return entries.get(eventId)
}

export function subscribeToDecryption(eventId: string, listener: () => void): () => void {
  let set = listeners.get(eventId)
  if (!set) {
    set = new Set()
    listeners.set(eventId, set)
  }
  set.add(listener)
  return () => {
    const current = listeners.get(eventId)
    if (!current) return
    current.delete(listener)
    if (current.size === 0) listeners.delete(eventId)
  }
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
  const existing = entries.get(eventId)
  if (existing && existing.status !== "pending") return Promise.resolve(existing)

  const pending = inflight.get(eventId)
  if (pending) return pending

  touch(eventId, { status: "pending", content: null })

  const startGeneration = generation
  const promise = (async (): Promise<DecryptCacheEntry> => {
    const decrypted = await tryDecryptMessagePayload(payload, opts)
    const entry: DecryptCacheEntry = decrypted
      ? { status: "decrypted", content: decrypted }
      : { status: "failed", content: null }
    // If the cache was cleared (lock / account switch) while this decrypt was
    // in flight, drop the result — writing it back would leak plaintext past
    // the lock boundary.
    if (startGeneration !== generation) return entry
    touch(eventId, entry)
    inflight.delete(eventId)
    emit(eventId)
    return entry
  })()

  inflight.set(eventId, promise)
  return promise
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
  const existing = entries.get(eventId)
  if (existing && existing.status === "decrypted") return
  touch(eventId, { status: "decrypted", content })
  inflight.delete(eventId)
  emit(eventId)
}

export function clearDecryptCache(): void {
  generation++
  const ids = Array.from(entries.keys())
  entries.clear()
  inflight.clear()
  for (const id of ids) emit(id)
}
