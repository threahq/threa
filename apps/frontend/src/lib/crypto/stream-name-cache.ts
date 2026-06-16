import { tryOpenStreamName, type DecryptMessageOpts } from "./message-envelope"
import { createDecryptedCache, type DecryptStatus } from "./decrypted-cache"

/**
 * In-memory cache for decrypted E2E stream names — a global-subscription instance
 * of the shared {@link createDecryptedCache} primitive (which owns the
 * inflight-dedup, lock-epoch guard, version signal, and lock-clear registration).
 *
 * The enclave seals a scratchpad's auto-title (and a manual rename re-seals it)
 * under the stream's SSK, AAD-bound to the stream. The ciphertext lives at rest
 * in `db.streams` (`sealedNameCiphertext`/`sealedNameEnvelope`); the decrypted
 * plaintext is held ONLY here and is never persisted. A single global version
 * counter drives re-renders: the store-read overlay (`useWorkspaceStreams`) and
 * the open-stream header subscribe once and re-read when any name lands. Keyed by
 * `${workspaceId}:${streamId}:${ciphertext}` so a rename (fresh ciphertext)
 * supersedes the prior plaintext without a manual purge, and a never-decrypted key
 * reads `null` rather than a stale value.
 *
 * Unlike message bodies, a null open is transient (locked / not a recipient yet /
 * wrap not resolvable), so the instance uses `retryFailed` — a later request
 * retries instead of pinning the placeholder. `clearStreamNameCache()` (also
 * fired by `clearAllDecrypted` on lock) drops everything.
 */

interface NameEntry {
  status: DecryptStatus
  /** The decrypted name; null while pending or after a failed/locked open. */
  value: string | null
}

const cache = createDecryptedCache<NameEntry>({
  subscription: "global",
  // A null open is transient (locked, or a wrap that becomes resolvable later),
  // so a later request must retry rather than pin the placeholder forever.
  retryFailed: true,
  pending: () => ({ status: "pending", value: null }),
  // Keys are content-addressed by ciphertext, so a primed name is idempotent;
  // skip the redundant emit when the cached value already matches.
  skipPrime: (existing, next) => existing?.status === "decrypted" && existing.value === next.value,
})

export function streamNameCacheKey(workspaceId: string, streamId: string, ciphertext: string): string {
  return `${workspaceId}:${streamId}:${ciphertext}`
}

export function subscribeStreamNameCache(listener: () => void): () => void {
  return cache.subscribe(null, listener)
}

export function getStreamNameCacheVersion(): number {
  return cache.getVersion()
}

/** The decrypted name for a key, or `null` if not yet decrypted / decrypt failed. */
export function getCachedStreamName(key: string): string | null {
  return cache.peek(key)?.value ?? null
}

/**
 * Whether a sealed name is still resolving: no entry yet (a decrypt is imminent)
 * or one is in flight. Once a decrypt settles — with a name, or without one
 * (non-recipient / forged AAD) — this returns false, so the UI can stop showing a
 * loader and fall back to the placeholder rather than spinning forever. A surface
 * uses this to avoid flashing the placeholder during the cold-load decrypt window.
 */
export function isStreamNamePending(key: string): boolean {
  const entry = cache.peek(key)
  return entry === undefined || entry.status === "pending"
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
 * null (locked, not a recipient, forged AAD) records a `failed` entry but does
 * not pin it: because the instance is `retryFailed`, a later unlock (or a wrap
 * that becomes resolvable) retries instead of pinning the placeholder — callers
 * fall back to the plaintext label meanwhile.
 */
export function requestStreamName(
  key: string,
  payload: RequestStreamNameInput,
  opts: DecryptMessageOpts
): Promise<void> {
  return cache
    .request(key, async () => {
      const decrypted = await tryOpenStreamName({ ciphertext: payload.ciphertext, envelope: payload.envelope }, opts)
      return decrypted == null ? { status: "failed", value: null } : { status: "decrypted", value: decrypted }
    })
    .then(() => {})
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
  cache.clear()
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
  cache.prime(key, { status: "decrypted", value: name })
}
