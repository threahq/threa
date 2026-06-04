import {
  base64ToBytes,
  bytesToBase64,
  generateStreamKey,
  openMessage,
  sealMessage,
  STREAM_ENVELOPE_VERSION,
  utf8Encode,
} from "@threa/crypto"

/**
 * One end-to-end-encrypted attachment, carried inside the SSK-sealed message
 * payload (its `attachmentRefs`) and never on the wire in clear. `key`/`iv`
 * open the opaque S3 ciphertext; `filename`/`mimeType`/`sizeBytes` are the real
 * values the server's placeholder row deliberately hides. See
 * `.claude/plans/e2e-attachments.md`.
 */
export interface AttachmentRef {
  attachmentId: string
  /** Base64 of the 32-byte single-use AES-256-GCM key for this attachment. */
  key: string
  /** Base64 12-byte GCM IV (from the seal envelope). */
  iv: string
  filename: string
  mimeType: string
  sizeBytes: number
}

// Domain-separation label bound as GCM AAD. The per-attachment key is random
// and used exactly once, so relocation/confusion attacks gain nothing and the
// AAD's only job is to satisfy the AEAD interface and pin the ciphertext to
// this scheme. It carries no secret and is reconstructed verbatim by the
// decrypt path (Slice B2).
const ATTACHMENT_AAD = utf8Encode("threa-attachment-v1")
/** Single-key scheme: attachment keys are per-file, never rotated. */
const ATTACHMENT_KEY_GENERATION = 0

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

/**
 * Decrypt the opaque S3 ciphertext of an E2E attachment back to its bytes, using
 * the `key`/`iv` carried in the message's `attachmentRef`. Inverse of
 * `encryptAttachmentBytes` — reconstructs the same single-key envelope (gen 0,
 * the domain-separation AAD) and opens it. Throws if the key/iv don't match or
 * the bytes were tampered (AES-GCM tag check).
 */
export async function decryptAttachmentBytes(input: {
  ciphertext: Uint8Array
  key: string
  iv: string
}): Promise<Uint8Array<ArrayBuffer>> {
  return openMessage({
    key: base64ToBytes(input.key),
    envelope: {
      v: STREAM_ENVELOPE_VERSION,
      keyGeneration: ATTACHMENT_KEY_GENERATION,
      iv: input.iv,
      aad: bytesToBase64(ATTACHMENT_AAD),
    },
    ciphertext: input.ciphertext,
  })
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
