import { base64ToBytes, bytesToBase64, concatBytes, utf8Decode, utf8Encode } from "./encoding"
import { importRecipientPublicKey, open as hpkeOpen, seal as hpkeSeal } from "./hpke"

/**
 * Per-stream symmetric key (SSK) primitives.
 *
 * Every end-to-end-encrypted stream owns an AES-256 key (the SSK) scoped to a
 * `keyGeneration`. Messages are AEAD-sealed directly under the SSK; the SSK
 * itself is never stored in plaintext — it exists only HPKE-wrapped to each
 * authorized recipient's long-term key (a member's UIK or a live enclave EIK).
 *
 * This differs from `envelope.ts` (the per-message recipient-fan-out shape used
 * by the user↔bot E2E path): there the message carries its own recipient list
 * and a fresh random key each time. Here the recipient wrapping lives out of
 * band (one `wrapStreamKey` per recipient per generation) so authorization is
 * cryptographic — a non-recipient is never wrapped the SSK — and so an enclave
 * redeploy only re-wraps the existing SSK to the new EIK rather than losing
 * history sealed under a dead key.
 */

/** Stream-envelope version. Distinct namespace from `ENVELOPE_VERSION` (the
 * recipient-fan-out shape); a reader switches on `e2e_version` / `envelope.v`. */
export const STREAM_ENVELOPE_VERSION = 2
const SSK_LENGTH = 32 // AES-256
const IV_LENGTH = 12

/** Generate a fresh 32-byte SSK for a new stream or key generation. */
export function generateStreamKey(): Uint8Array<ArrayBuffer> {
  const key = new Uint8Array(SSK_LENGTH)
  crypto.getRandomValues(key)
  return key
}

/**
 * The message-level envelope for SSK-sealed content. Unlike `Envelope` it
 * carries no recipient list — recipients are resolved out of band via the
 * stream's key wraps for `keyGeneration`. The AES-GCM ciphertext is returned
 * separately (stored in `messages.ciphertext`); only the framing lives here.
 */
export interface StreamEnvelope {
  /** Always `STREAM_ENVELOPE_VERSION`; old clients reject an unknown version loudly. */
  v: number
  /** Which generation of the stream's SSK sealed this message. */
  keyGeneration: number
  /** Base64-encoded AES-GCM IV. */
  iv: string
  /** Base64-encoded AAD (caller-supplied binding bytes — see `buildMessageAad`). */
  aad: string
}

export interface SealMessageInput {
  /** 32-byte SSK for `keyGeneration`. */
  key: Uint8Array
  keyGeneration: number
  payload: Uint8Array | string
  /**
   * Bytes bound into AEAD as additional-authenticated-data — use
   * `buildMessageAad` so the same bytes can be reconstructed at open time.
   */
  aad?: Uint8Array
}

export interface SealMessageResult {
  envelope: StreamEnvelope
  /** AES-256-GCM ciphertext (tag included). Store in `messages.ciphertext`. */
  ciphertext: Uint8Array<ArrayBuffer>
}

/** AEAD-seal a message payload under the stream's SSK for `keyGeneration`. */
export async function sealMessage(input: SealMessageInput): Promise<SealMessageResult> {
  if (input.key.length !== SSK_LENGTH) {
    throw new Error(`sealMessage: SSK must be ${SSK_LENGTH} bytes, got ${input.key.length}`)
  }

  const iv = new Uint8Array(IV_LENGTH)
  crypto.getRandomValues(iv)

  const plaintext: Uint8Array<ArrayBuffer> =
    typeof input.payload === "string" ? utf8Encode(input.payload) : new Uint8Array(input.payload)
  const aad: Uint8Array<ArrayBuffer> = input.aad ? new Uint8Array(input.aad) : new Uint8Array(0)

  const sskKey = await crypto.subtle.importKey("raw", new Uint8Array(input.key), { name: "AES-GCM" }, false, [
    "encrypt",
  ])
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad }, sskKey, plaintext)
  )

  return {
    envelope: {
      v: STREAM_ENVELOPE_VERSION,
      keyGeneration: input.keyGeneration,
      iv: bytesToBase64(iv),
      aad: bytesToBase64(aad),
    },
    ciphertext,
  }
}

export interface OpenMessageInput {
  /** 32-byte SSK for `envelope.keyGeneration`. */
  key: Uint8Array
  envelope: StreamEnvelope
  /** AES-256-GCM ciphertext (tag included) — as stored in `messages.ciphertext`. */
  ciphertext: Uint8Array
}

/** Open an SSK-sealed message. Throws on version mismatch, wrong key, or forged AAD. */
export async function openMessage(input: OpenMessageInput): Promise<Uint8Array<ArrayBuffer>> {
  if (input.envelope.v !== STREAM_ENVELOPE_VERSION) {
    throw new Error(`Unsupported stream envelope version: ${input.envelope.v}`)
  }
  if (input.key.length !== SSK_LENGTH) {
    throw new Error(`openMessage: SSK must be ${SSK_LENGTH} bytes, got ${input.key.length}`)
  }

  const aad = base64ToBytes(input.envelope.aad)
  const sskKey = await crypto.subtle.importKey("raw", new Uint8Array(input.key), { name: "AES-GCM" }, false, [
    "decrypt",
  ])
  const plaintext = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64ToBytes(input.envelope.iv), additionalData: aad },
      sskKey,
      new Uint8Array(input.ciphertext)
    )
  )
  return plaintext
}

export async function openMessageAsString(input: OpenMessageInput): Promise<string> {
  return utf8Decode(await openMessage(input))
}

export interface StreamKeyWrap {
  /** Base-layer HPKE encapsulation. Store in `stream_e2e_key_wraps.wrap_enc`. */
  enc: Uint8Array<ArrayBuffer>
  /** HPKE-wrapped SSK bytes. Store in `stream_e2e_key_wraps.wrap_ct`. */
  ct: Uint8Array<ArrayBuffer>
}

export interface WrapStreamKeyInput {
  /** 32-byte SSK to wrap. */
  key: Uint8Array
  /** Raw X25519 public key of the recipient (a member's UIK or a live EIK). */
  recipientPublicKey: Uint8Array
  /** Binding bytes — use `buildWrapAad` so a wrap can't be relocated between rows. */
  aad?: Uint8Array
}

/** HPKE-wrap the SSK so only the holder of the recipient's private key recovers it. */
export async function wrapStreamKey(input: WrapStreamKeyInput): Promise<StreamKeyWrap> {
  if (input.key.length !== SSK_LENGTH) {
    throw new Error(`wrapStreamKey: SSK must be ${SSK_LENGTH} bytes, got ${input.key.length}`)
  }
  const recipient = await importRecipientPublicKey(input.recipientPublicKey)
  const sealed = await hpkeSeal({ recipientPublicKey: recipient, plaintext: new Uint8Array(input.key), aad: input.aad })
  return { enc: sealed.enc, ct: sealed.ct }
}

export interface UnwrapStreamKeyInput {
  enc: Uint8Array
  ct: Uint8Array
  /** The recipient's HPKE private key (UIK or EIK). */
  recipientPrivateKey: CryptoKey
  /** Must match the `aad` used at wrap time (see `buildWrapAad`). */
  aad?: Uint8Array
}

/** Recover the SSK from a wrap. Throws if the key doesn't match or AAD is forged. */
export async function unwrapStreamKey(input: UnwrapStreamKeyInput): Promise<Uint8Array<ArrayBuffer>> {
  const key = await hpkeOpen({
    recipientPrivateKey: input.recipientPrivateKey,
    enc: input.enc,
    ct: input.ct,
    aad: input.aad,
  })
  if (key.length !== SSK_LENGTH) {
    throw new Error(`unwrapStreamKey: recovered key is ${key.length} bytes, expected ${SSK_LENGTH}`)
  }
  return key
}

/**
 * Canonical AAD for an SSK wrap. Binds a wrap to its `(streamId, keyGeneration,
 * recipientKeyId)` slot so a malicious server can't relocate a wrap row to a
 * different stream/generation/recipient. Keep stable — changing the layout
 * breaks unwrapping of every existing wrap.
 */
export function buildWrapAad(parts: {
  streamId: string
  keyGeneration: number
  recipientKeyId: string
}): Uint8Array<ArrayBuffer> {
  return concatBytes(
    utf8Encode(parts.streamId),
    utf8Encode("|"),
    utf8Encode(String(parts.keyGeneration)),
    utf8Encode("|"),
    utf8Encode(parts.recipientKeyId)
  )
}
