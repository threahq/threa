import { type AttachmentRef } from "@threa/crypto"
import { registerDecryptedCache } from "./decrypted-cache"

// The `AttachmentRef` type and the encrypt/decrypt primitives are canonical in
// @threa/crypto so the enclave and the bot-runtime SDK share them (INV-35).
// Re-export them here so existing call sites that import from this module keep
// working.
export {
  decryptAttachmentBytes,
  encryptAttachmentBytes,
  type AttachmentRef,
  type EncryptedAttachment,
} from "@threa/crypto"

// In-memory bridge from upload time (where the per-attachment key/iv are
// minted) to send time (where they're sealed into the message). Keyed by the
// server attachment id. This holds key material, so it is cleared on session
// lock / account switch alongside the SSK and decrypt caches (see
// `e2e-session-store`) and is never persisted — a reload before send drops it
// by design, and the send path fails loud rather than ship an undecryptable
// attachment.
const pendingRefs = new Map<string, AttachmentRef>()

export function rememberAttachmentRef(ref: AttachmentRef): void {
  pendingRefs.set(ref.attachmentId, ref)
}

/** Read the ref for an uploaded E2E attachment, or null if it isn't known. */
export function getAttachmentRef(attachmentId: string): AttachmentRef | null {
  return pendingRefs.get(attachmentId) ?? null
}

export function clearAttachmentRefCache(): void {
  pendingRefs.clear()
}

// The pre-send key bridge holds AES key material, so it dies on the same lock
// boundary as decrypted plaintext via the single `clearAllDecrypted()` call site.
registerDecryptedCache(clearAttachmentRefCache)
