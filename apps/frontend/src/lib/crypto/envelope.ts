import { bytesToBase64, base64ToBytes, concatBytes, utf8Decode, utf8Encode } from "./encoding"
import { importRecipientPublicKey, open as hpkeOpen, seal as hpkeSeal } from "./hpke"

/**
 * Per-message envelope shape: a single random `messageKey` encrypts the
 * payload with AES-256-GCM, and HPKE wraps `messageKey` to every recipient
 * individually. Recipients pick the entry matching their `keyId`, HPKE-open
 * to recover `messageKey`, then AES-open the payload.
 *
 * `aad` binds the envelope to its message metadata so the server can't shuffle
 * envelopes between rows without the GCM tag failing.
 */

export const ENVELOPE_VERSION = 1
const MESSAGE_KEY_LENGTH = 32 // AES-256
const IV_LENGTH = 12

export interface EnvelopeRecipientPublic {
  /** Stable id stored alongside the recipient's public key (e.g. UIK key_id). */
  recipientKeyId: string
  /** Raw 32-byte X25519 public key. */
  publicKey: Uint8Array
}

export interface EnvelopeRecipient {
  recipientKeyId: string
  /** Base64-encoded HPKE encapsulation. */
  enc: string
  /** Base64-encoded HPKE-wrapped messageKey. */
  ct: string
}

export interface Envelope {
  /** Envelope protocol version — bump on shape change so old clients reject loudly. */
  v: number
  /** Base64-encoded payload ciphertext (AES-256-GCM, tag included). */
  ciphertext: string
  /** Base64-encoded AES-GCM IV. */
  iv: string
  /** Base64-encoded AAD (caller-supplied binding bytes). */
  aad: string
  recipients: EnvelopeRecipient[]
}

export interface EncryptInput {
  payload: Uint8Array | string
  recipients: EnvelopeRecipientPublic[]
  /**
   * Bytes bound into AEAD as additional-authenticated-data. Should be a
   * canonical encoding of stable message metadata: `streamId ‖ messageId ‖
   * senderId`. The same bytes have to be reconstructible at decrypt time —
   * keep the canonicalization stable.
   */
  aad?: Uint8Array
}

export interface EncryptResult {
  envelope: Envelope
}

/**
 * Build an envelope: generate a fresh per-message key, AES-encrypt the
 * payload under it, then HPKE-wrap that key to every recipient.
 */
export async function encryptPayload(input: EncryptInput): Promise<EncryptResult> {
  if (input.recipients.length === 0) {
    throw new Error("encryptPayload: at least one recipient is required")
  }

  const messageKeyBytes = new Uint8Array(MESSAGE_KEY_LENGTH)
  crypto.getRandomValues(messageKeyBytes)

  const iv = new Uint8Array(IV_LENGTH)
  crypto.getRandomValues(iv)

  const plaintext: Uint8Array<ArrayBuffer> =
    typeof input.payload === "string" ? utf8Encode(input.payload) : new Uint8Array(input.payload)
  const aad: Uint8Array<ArrayBuffer> = input.aad ? new Uint8Array(input.aad) : new Uint8Array(0)

  const messageKey = await crypto.subtle.importKey("raw", messageKeyBytes, { name: "AES-GCM" }, false, ["encrypt"])
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad }, messageKey, plaintext)
  )

  const recipients: EnvelopeRecipient[] = await Promise.all(
    input.recipients.map(async (recipient) => {
      const pubKey = await importRecipientPublicKey(recipient.publicKey)
      const sealed = await hpkeSeal({
        recipientPublicKey: pubKey,
        plaintext: messageKeyBytes,
        aad,
      })
      return {
        recipientKeyId: recipient.recipientKeyId,
        enc: bytesToBase64(sealed.enc),
        ct: bytesToBase64(sealed.ct),
      }
    })
  )

  return {
    envelope: {
      v: ENVELOPE_VERSION,
      ciphertext: bytesToBase64(ciphertext),
      iv: bytesToBase64(iv),
      aad: bytesToBase64(aad),
      recipients,
    },
  }
}

export interface DecryptInput {
  envelope: Envelope
  /** The recipient's HPKE private key (typically the user's UIK). */
  privateKey: CryptoKey
  /** Matches against `recipients[].recipientKeyId` to pick the right HPKE entry. */
  recipientKeyId: string
}

/**
 * Decrypt an envelope. Throws if no recipient entry matches `recipientKeyId`
 * or if AAD verification fails.
 */
export async function decryptPayload(input: DecryptInput): Promise<Uint8Array> {
  if (input.envelope.v !== ENVELOPE_VERSION) {
    throw new Error(`Unsupported envelope version: ${input.envelope.v}`)
  }

  const entry = input.envelope.recipients.find((r) => r.recipientKeyId === input.recipientKeyId)
  if (!entry) {
    throw new Error(`Envelope is not addressed to ${input.recipientKeyId}`)
  }

  const aad = base64ToBytes(input.envelope.aad)
  const messageKeyBytes = await hpkeOpen({
    recipientPrivateKey: input.privateKey,
    enc: base64ToBytes(entry.enc),
    ct: base64ToBytes(entry.ct),
    aad,
  })

  const messageKey = await crypto.subtle.importKey("raw", messageKeyBytes, { name: "AES-GCM" }, false, ["decrypt"])
  const plaintext = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64ToBytes(input.envelope.iv), additionalData: aad },
      messageKey,
      base64ToBytes(input.envelope.ciphertext)
    )
  )
  return plaintext
}

export async function decryptPayloadAsString(input: DecryptInput): Promise<string> {
  return utf8Decode(await decryptPayload(input))
}

/**
 * Canonical AAD builder for message envelopes. Keep this stable — changes
 * here break decryption of all messages encrypted under the old layout.
 */
export function buildMessageAad(parts: { streamId: string; messageId: string; senderId: string }): Uint8Array {
  return concatBytes(
    utf8Encode(parts.streamId),
    utf8Encode("|"),
    utf8Encode(parts.messageId),
    utf8Encode("|"),
    utf8Encode(parts.senderId)
  )
}
