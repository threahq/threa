import {
  ATTACHMENT_AAD,
  ATTACHMENT_KEY_GENERATION,
  bytesToBase64,
  generateStreamKey,
  sealMessage,
  type AttachmentRef,
} from "@threa/crypto"

// The `AttachmentRef` type and the `decryptAttachmentBytes` open primitive are
// canonical in @threa/crypto so the enclave shares them (INV-35). Re-export them
// here so existing call sites that import from this module keep working.
export { decryptAttachmentBytes, type AttachmentRef } from "@threa/crypto"

export interface EncryptedAttachment {
  /** Ciphertext bytes to upload as the opaque file body (a valid `BlobPart`). */
  ciphertext: Uint8Array<ArrayBuffer>
  /** Base64 key + iv to stash in the message's `attachmentRefs`. */
  key: string
  iv: string
}

/**
 * Encrypt a file's bytes under a fresh single-use key for upload to an E2E
 * stream. Returns the ciphertext plus the key/iv the message payload must carry
 * so the owner can decrypt it later. Reuses the message seal primitive
 * (AES-256-GCM) rather than a parallel raw-bytes path (INV-35). Takes raw bytes
 * (the caller reads them off the `File`) so this stays a pure crypto function.
 */
export async function encryptAttachmentBytes(plaintext: Uint8Array): Promise<EncryptedAttachment> {
  const key = generateStreamKey()
  const { envelope, ciphertext } = await sealMessage({
    key,
    keyGeneration: ATTACHMENT_KEY_GENERATION,
    payload: plaintext,
    aad: ATTACHMENT_AAD,
  })
  return { ciphertext, key: bytesToBase64(key), iv: envelope.iv }
}

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
