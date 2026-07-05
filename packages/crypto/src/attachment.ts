import { base64ToBytes, bytesToBase64, utf8Encode } from "./encoding"
import { generateStreamKey, openMessage, sealMessage, STREAM_ENVELOPE_VERSION } from "./stream-key"

/**
 * One end-to-end-encrypted attachment, carried inside the SSK-sealed message
 * payload (its `attachmentRefs`) and never on the wire in clear. `key`/`iv`
 * open the opaque S3 ciphertext; `filename`/`mimeType`/`sizeBytes` are the real
 * values the server's placeholder row deliberately hides.
 *
 * Lives in the shared crypto package so both the browser (encrypt on upload,
 * decrypt on view) and the enclave (decrypt to feed the model) use one
 * definition and one open primitive — no parallel implementation (INV-35).
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
// this scheme. It carries no secret and is reconstructed verbatim on decrypt.
export const ATTACHMENT_AAD = utf8Encode("threa-attachment-v1")
/** Single-key scheme: attachment keys are per-file, never rotated. */
export const ATTACHMENT_KEY_GENERATION = 0

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
 * so a recipient can decrypt it later. Reuses the message seal primitive
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
 * the `key`/`iv` carried in the message's `attachmentRef`. Reconstructs the
 * single-key envelope (gen 0, the domain-separation AAD) and opens it. Throws if
 * the key/iv don't match or the bytes were tampered (AES-GCM tag check).
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
