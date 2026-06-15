import { tryOpenStreamName, type DecryptMessageOpts } from "./message-envelope"

/**
 * In-memory cache for decrypted E2E stream names.
 *
 * The enclave seals a scratchpad's auto-title (and a manual rename re-seals it)
 * under the stream's SSK, AAD-bound to the stream. The ciphertext lives at rest
 * in `db.streams` (`sealedNameCiphertext`/`sealedNameEnvelope`); the decrypted
 * plaintext is held ONLY here and is never persisted, mirroring `decrypt-cache`
 * for message bodies. This keeps a single decrypt authority for names so every
 * surface that resolves a label (sidebar, search, breadcrumbs, …) reflects the
 * tamper-evident name without each re-implementing the decrypt.
 *
 * A single global version counter drives re-renders: the store-read overlay
 * (`useWorkspaceStreams`) and the open-stream header subscribe once and re-read
 * when any name lands. Keyed by `${workspaceId}:${streamId}:${ciphertext}` so a
 * rename (fresh ciphertext) supersedes the prior plaintext without a manual
 * purge, and a never-decrypted key reads `null` rather than a stale value.
 *
 * Lifecycle: `clearStreamNameCache()` drops everything and bumps the lock epoch
 * so an in-flight decrypt that resolves after a lock refuses to write plaintext
 * back — call it on session lock / account switch, the same boundary
 * `clearDecryptCache` / `clearStreamKeyCache` enforce.
 */

/** Decrypted plaintext names keyed by `${workspaceId}:${streamId}:${ciphertext}`. */
const names = new Map<string, string>()
const inflight = new Map<string, Promise<void>>()
const listeners = new Set<() => void>()

// Monotonic snapshot for useSyncExternalStore — bumped on every cache change so
// subscribers (the overlay, the open-stream header) re-read.
let version = 0
// Bumped by clearStreamNameCache so an in-flight decrypt that resolves after a
// lock detects it's stale and refuses to write plaintext back into the cache.
let generation = 0

export function streamNameCacheKey(workspaceId: string, streamId: string, ciphertext: string): string {
  return `${workspaceId}:${streamId}:${ciphertext}`
}

function emit(): void {
  version++
  for (const listener of listeners) listener()
}

export function subscribeStreamNameCache(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getStreamNameCacheVersion(): number {
  return version
}

/** The decrypted name for a key, or `null` if not yet decrypted / decrypt failed. */
export function getCachedStreamName(key: string): string | null {
  return names.get(key) ?? null
}

export interface RequestStreamNameInput {
  /** Base64 ciphertext from `sealedNameCiphertext`. */
  ciphertext: string
  /** `StreamEnvelope` framing from `sealedNameEnvelope`. */
  envelope: unknown
}

/**
 * Decrypt a sealed stream name and cache the plaintext, deduped per key. A
 * no-op when the key is already decrypted or in flight. A decrypt that returns
 * null (locked, not a recipient, forged AAD) is not cached, so a later unlock
 * (or a wrap that becomes resolvable) retries instead of pinning the
 * placeholder — callers fall back to the plaintext label meanwhile.
 */
export function requestStreamName(
  key: string,
  payload: RequestStreamNameInput,
  opts: DecryptMessageOpts
): Promise<void> {
  const existing = inflight.get(key)
  if (existing) return existing
  if (names.has(key)) return Promise.resolve()

  const startGeneration = generation
  const promise = (async () => {
    const decrypted = await tryOpenStreamName({ ciphertext: payload.ciphertext, envelope: payload.envelope }, opts)
    // Dropped if the cache was cleared (lock / account switch) mid-flight —
    // writing plaintext back would leak it past the lock boundary.
    if (startGeneration !== generation) return
    inflight.delete(key)
    if (decrypted == null) return
    names.set(key, decrypted)
    emit()
  })()

  inflight.set(key, promise)
  return promise
}

/**
 * Overlay decrypted names onto a list of streams: for each unlocked, sealed E2E
 * stream whose name is cached, replace `displayName` with the tamper-evident
 * decrypted copy. Identity-preserving — returns the input array unchanged when
 * nothing is overlaid, and only allocates fresh objects for streams it rewrites,
 * so the resolver (`streamLabel`/`resolveStreamName`) reflects the decrypted
 * name with no per-surface plumbing. Locked / undecrypted streams keep their
 * plaintext `displayName` (the placeholder for an auto-titled scratchpad).
 */
export function applyDecryptedNameOverlay<
  T extends {
    id: string
    displayName: string | null
    e2eEnabled?: boolean
    sealedNameCiphertext?: string | null
  },
>(workspaceId: string, streams: T[]): T[] {
  let changed = false
  const next = streams.map((stream) => {
    if (!stream.e2eEnabled || !stream.sealedNameCiphertext) return stream
    const decrypted = getCachedStreamName(streamNameCacheKey(workspaceId, stream.id, stream.sealedNameCiphertext))
    if (decrypted == null || decrypted === stream.displayName) return stream
    changed = true
    return { ...stream, displayName: decrypted }
  })
  return changed ? next : streams
}

export function clearStreamNameCache(): void {
  generation++
  names.clear()
  inflight.clear()
  emit()
}

/**
 * Seed the cache with a plaintext name we already hold — the local rename path,
 * which sealed the name itself, so it knows the cleartext without decrypting.
 * Keyed by the fresh ciphertext, so the store-read overlay and the open-stream
 * header resolve the new name the instant the stream row flips to that ciphertext
 * instead of flashing the placeholder while an async re-decrypt of our own write
 * round-trips. Memory-only and cleared on lock like every other entry.
 */
export function primeStreamName(key: string, name: string): void {
  if (names.get(key) === name) return
  names.set(key, name)
  emit()
}
