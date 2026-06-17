import { createDecryptedCache, type DecryptStatus } from "./decrypted-cache"

/**
 * In-memory cache for decrypted E2E attachment bytes — a per-key instance of the
 * shared {@link createDecryptedCache} primitive (inflight-dedup, lock-epoch guard,
 * subscribe/version signal, LRU, lock-clear registration).
 *
 * An E2E attachment is opaque ciphertext on the server; the per-file key/iv ride
 * sealed inside the message payload. Reading one means fetching the ciphertext and
 * decrypting it in memory — expensive, and previously redone on every mount/scroll
 * because attachments had no read cache. This caches the decrypted `Blob` keyed by
 * the server attachment id, so re-mounting a previously-decrypted image is free.
 *
 * The cache holds bytes only; the object URL lifecycle (create/revoke) stays in the
 * read hook (`useDecryptedAttachment`), which is React-managed and can revoke on
 * unmount — a URL cached here would leak its blob past lock. A null open (fetch or
 * decrypt failure) is transient (network blip), so the instance uses `retryFailed`:
 * a later request — e.g. the file-download retry — re-attempts rather than pinning
 * the failure. `clearAttachmentBytesCache()` (also fired by `clearAllDecrypted` on
 * lock) drops every blob so plaintext bytes never outlive the unlocked session.
 */

export interface AttachmentBytesEntry {
  status: DecryptStatus
  /** Decrypted file bytes; null while pending or after a failed fetch/decrypt. */
  value: Blob | null
}

const cache = createDecryptedCache<AttachmentBytesEntry>({
  subscription: "per-key",
  // Blobs are whole files (MBs each), so cap aggressively — the goal is making a
  // recently-viewed attachment re-render free, not retaining every file scrolled past.
  lru: 64,
  // A fetch/decrypt miss is transient (network), so allow a later request to retry.
  retryFailed: true,
  pending: () => ({ status: "pending", value: null }),
})

export function getCachedAttachmentBytes(attachmentId: string): AttachmentBytesEntry | undefined {
  return cache.peek(attachmentId)
}

export function subscribeToAttachmentBytes(attachmentId: string, listener: () => void): () => void {
  return cache.subscribe(attachmentId, listener)
}

/**
 * Fetch + decrypt an attachment's bytes once and cache the resulting `Blob`,
 * deduping concurrent callers. `fetchDecrypt` does the network fetch and in-memory
 * decrypt (it carries the per-file key/iv); a throw is recorded as a `failed` entry
 * the UI can react to, and — because the instance is `retryFailed` — a later request
 * re-runs it. Returns the settled entry so an on-demand caller (download) can use it.
 */
export function requestAttachmentBytes(
  attachmentId: string,
  fetchDecrypt: () => Promise<Blob>
): Promise<AttachmentBytesEntry> {
  return cache.request(attachmentId, async () => {
    try {
      return { status: "decrypted", value: await fetchDecrypt() }
    } catch {
      return { status: "failed", value: null }
    }
  })
}

export function clearAttachmentBytesCache(): void {
  cache.clear()
}
