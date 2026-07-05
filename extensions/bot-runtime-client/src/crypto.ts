/**
 * Vendored subset of `@threa/crypto` (the repo's `packages/crypto`).
 *
 * The bot-runtime extensions ship standalone — they are copied to the user's
 * machine (e.g. `~/.pi/agent/extensions/`) and installed there, where the
 * private, unpublished `@threa/crypto` workspace package cannot resolve. So the
 * slice the sealed (E2EE) bot path needs is copied here verbatim and depends
 * only on the published `@hpke/*` packages plus WebCrypto. Both harnesses
 * (pi-remote, claude-code-remote via remote-session) consume this one copy.
 *
 * Source of truth: `packages/crypto/src/{encoding,hpke,stream-key,envelope,sealed-payload,attachment}.ts`.
 * `crypto.parity.test.ts` imports BOTH this module and the canonical package and
 * asserts byte-for-byte agreement on the AAD builders, envelope/payload versions,
 * and cross seal/open + wrap/unwrap round-trips — so a drift here fails loudly.
 * Keep the two in sync; if the canonical AAD layout or envelope version changes,
 * the owner's client can no longer open this harness's sealed replies.
 *
 * Only the recipient/seal half lives here: the harness unwraps the stream key
 * with its identity private key, opens history/prompt, and seals replies/steps
 * under the stream key. It never wraps a key to another recipient, so the HPKE
 * `seal`/`wrapStreamKey` direction is deliberately omitted.
 */

import { Aes256Gcm, CipherSuite, HkdfSha256 } from "@hpke/core"
// Pure-JS (noble) X25519 KEM, NOT `@hpke/core`'s native one. The harnesses run
// in whatever runtime hosts them; Bun's WebCrypto lacks X25519 `deriveBits`, so
// the native KEM throws `EncapError/DecapError: The algorithm is not supported`
// there. The noble KEM works in any JS runtime and is the identical RFC 9180
// DHKEM(X25519, HKDF-SHA256) — wire-compatible with the canonical native KEM the
// owner's browser/enclave wraps with (`@hpke` supports mixing the two; keys
// serialize to the same 32 raw bytes).
import { DhkemX25519HkdfSha256 } from "@hpke/dhkem-x25519"

// ── encoding ────────────────────────────────────────────────────────────────

export function bytesToBase64(bytes: Uint8Array | ArrayBuffer): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let binary = ""
  for (let i = 0; i < view.length; i++) binary += String.fromCharCode(view[i]!)
  return btoa(binary)
}

export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export function utf8Encode(text: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>
}

export function utf8Decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  let total = 0
  for (const p of parts) total += p.length
  const out = new Uint8Array(total)
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.length
  }
  return out
}

// ── HPKE (RFC 9180: DHKEM(X25519, HKDF-SHA256) + HKDF-SHA256 + AES-256-GCM) ────

let suite: CipherSuite | null = null

function getSuite(): CipherSuite {
  if (!suite) {
    suite = new CipherSuite({
      kem: new DhkemX25519HkdfSha256(),
      kdf: new HkdfSha256(),
      aead: new Aes256Gcm(),
    })
  }
  return suite
}

export async function generateKeyPair(): Promise<CryptoKeyPair> {
  return getSuite().kem.generateKeyPair()
}

export async function importRecipientPrivateKey(raw: Uint8Array | ArrayBuffer): Promise<CryptoKey> {
  const buf = raw instanceof Uint8Array ? raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) : raw
  return getSuite().kem.deserializePrivateKey(buf)
}

export async function exportPublicKey(key: CryptoKey): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await getSuite().kem.serializePublicKey(key))
}

export async function exportPrivateKey(key: CryptoKey): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await getSuite().kem.serializePrivateKey(key))
}

export async function importRecipientPublicKey(raw: Uint8Array | ArrayBuffer): Promise<CryptoKey> {
  const buf = raw instanceof Uint8Array ? raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) : raw
  return getSuite().kem.deserializePublicKey(buf)
}

/**
 * Decrypt an HPKE-sealed payload. Throws if `aad` does not match what the
 * sender used (the GCM tag fails verification).
 */
async function hpkeOpen(params: {
  recipientPrivateKey: CryptoKey
  enc: Uint8Array
  ct: Uint8Array
  aad?: Uint8Array
}): Promise<Uint8Array<ArrayBuffer>> {
  const buf = await getSuite().open(
    { recipientKey: params.recipientPrivateKey, enc: params.enc },
    params.ct,
    params.aad
  )
  return new Uint8Array(buf)
}

/** HPKE-seal a payload to a recipient public key (the wrap direction of `hpkeOpen`). */
async function hpkeSeal(params: {
  recipientPublicKey: CryptoKey
  payload: Uint8Array
  aad?: Uint8Array
}): Promise<{ enc: Uint8Array<ArrayBuffer>; ct: Uint8Array<ArrayBuffer> }> {
  const sealed = await getSuite().seal({ recipientPublicKey: params.recipientPublicKey }, params.payload, params.aad)
  return { enc: new Uint8Array(sealed.enc), ct: new Uint8Array(sealed.ct) }
}

// ── per-stream symmetric key (SSK) ───────────────────────────────────────────

/** Stream-envelope version; a reader switches on `envelope.v`. */
export const STREAM_ENVELOPE_VERSION = 2
const SSK_LENGTH = 32 // AES-256
const IV_LENGTH = 12

/**
 * Reject empty AAD at the boundary. Slot-binding is a security invariant of the
 * SSK design, so an empty `aad` is always a caller bug rather than a valid
 * "unbound" mode — fail loud instead of producing ciphertext that binds to nothing.
 */
function assertBoundAad(fn: string, aad: Uint8Array): void {
  if (aad.length === 0) {
    throw new Error(`${fn}: aad must be non-empty (see buildMessageAad/buildWrapAad)`)
  }
}

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
  /** Bytes bound into AEAD as additional-authenticated-data — use `buildMessageAad`. Required. */
  aad: Uint8Array
}

export interface SealMessageResult {
  envelope: StreamEnvelope
  /** AES-256-GCM ciphertext (tag included). */
  ciphertext: Uint8Array<ArrayBuffer>
}

/** AEAD-seal a message payload under the stream's SSK for `keyGeneration`. */
export async function sealMessage(input: SealMessageInput): Promise<SealMessageResult> {
  if (input.key.length !== SSK_LENGTH) {
    throw new Error(`sealMessage: SSK must be ${SSK_LENGTH} bytes, got ${input.key.length}`)
  }
  assertBoundAad("sealMessage", input.aad)

  const iv = new Uint8Array(IV_LENGTH)
  crypto.getRandomValues(iv)

  const plaintext: Uint8Array<ArrayBuffer> =
    typeof input.payload === "string" ? utf8Encode(input.payload) : new Uint8Array(input.payload)
  const aad: Uint8Array<ArrayBuffer> = new Uint8Array(input.aad)

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
  /** AES-256-GCM ciphertext (tag included). */
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

export interface UnwrapStreamKeyInput {
  enc: Uint8Array
  ct: Uint8Array
  /** The recipient's HPKE private key (the harness's BIK private key). */
  recipientPrivateKey: CryptoKey
  /** Must match the `aad` used at wrap time (see `buildWrapAad`). */
  aad: Uint8Array
}

export interface WrapStreamKeyInput {
  /** The 32-byte SSK to wrap. */
  key: Uint8Array
  /** The recipient's HPKE public key (imported via `importRecipientPublicKey`). */
  recipientPublicKey: CryptoKey
  /** Slot binding — use `buildWrapAad`. Required. */
  aad: Uint8Array
}

/**
 * HPKE-wrap an SSK to a recipient — used when a harness PROVISIONS a fresh
 * stream key for its own E2E scratchpad (wrapping to the owner's UIK and its
 * own BIK). Wire-identical to `@threa/crypto`'s `wrapStreamKey`; the parity
 * test asserts a vendored wrap opens with the vendored unwrap under the same
 * AAD binding.
 */
export async function wrapStreamKey(input: WrapStreamKeyInput): Promise<{ enc: Uint8Array; ct: Uint8Array }> {
  assertBoundAad("wrapStreamKey", input.aad)
  if (input.key.length !== SSK_LENGTH) {
    throw new Error(`wrapStreamKey: SSK must be ${SSK_LENGTH} bytes, got ${input.key.length}`)
  }
  return hpkeSeal({ recipientPublicKey: input.recipientPublicKey, payload: new Uint8Array(input.key), aad: input.aad })
}

/** A fresh random 32-byte SSK (AES-256). */
export function generateStreamKey(): Uint8Array<ArrayBuffer> {
  const key = new Uint8Array(SSK_LENGTH)
  crypto.getRandomValues(key)
  return key
}

/** Recover the SSK from a wrap. Throws if the key doesn't match or AAD is forged. */
export async function unwrapStreamKey(input: UnwrapStreamKeyInput): Promise<Uint8Array<ArrayBuffer>> {
  assertBoundAad("unwrapStreamKey", input.aad)
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
 * recipientKeyId)` slot so a malicious server can't relocate a wrap row. Keep
 * stable — changing the layout breaks unwrapping of every existing wrap.
 */
export function buildWrapAad(parts: {
  streamId: string
  keyGeneration: number
  recipientKeyId: string
}): Uint8Array<ArrayBuffer> {
  if (parts.streamId.length === 0 || parts.recipientKeyId.length === 0) {
    throw new Error("buildWrapAad: streamId and recipientKeyId must be non-empty")
  }
  if (parts.streamId.includes("|") || parts.recipientKeyId.includes("|")) {
    throw new Error("buildWrapAad: streamId and recipientKeyId must not contain '|'")
  }
  if (!Number.isInteger(parts.keyGeneration) || parts.keyGeneration < 0) {
    throw new Error("buildWrapAad: keyGeneration must be a non-negative integer")
  }
  return concatBytes(
    utf8Encode(parts.streamId),
    utf8Encode("|"),
    utf8Encode(String(parts.keyGeneration)),
    utf8Encode("|"),
    utf8Encode(parts.recipientKeyId)
  )
}

/**
 * Canonical AAD for an SSK-sealed message (and trace step — the `step_…` id
 * rides the `messageId` slot). Binds the ciphertext to `streamId|messageId|senderId`
 * so the server can't shuffle it onto another row. Keep stable.
 */
export function buildMessageAad(parts: {
  streamId: string
  messageId: string
  senderId: string
}): Uint8Array<ArrayBuffer> {
  return concatBytes(
    utf8Encode(parts.streamId),
    utf8Encode("|"),
    utf8Encode(parts.messageId),
    utf8Encode("|"),
    utf8Encode(parts.senderId)
  )
}

// ── E2E attachment bytes (per-file single-use key) ────────────────────────────

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
 * (AES-256-GCM) rather than a parallel raw-bytes path (INV-35).
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

// ── sealed payload wrapper ────────────────────────────────────────────────────

export const E2E_PAYLOAD_VERSION = 1

/** One citation source sealed into a payload (structural twin of `@threa/types`' `SourceItem`). */
export interface SealedSourceItem {
  type?: string
  title: string
  url: string
  snippet?: string
}

/** A per-file attachment key sealed into a payload (structural twin of `@threa/crypto`'s `AttachmentRef`). */
export interface AttachmentRef {
  attachmentId: string
  key: string
  iv: string
  filename: string
  mimeType: string
  sizeBytes: number
}

interface E2eSealedPayload {
  __e2ePayload: typeof E2E_PAYLOAD_VERSION
  contentMarkdown: string
  attachmentRefs: AttachmentRef[]
  sources?: SealedSourceItem[]
  draftContentJson?: unknown
}

export interface SealedPayloadExtras {
  attachmentRefs?: AttachmentRef[]
  sources?: SealedSourceItem[]
  draftContentJson?: unknown
}

/** Build the bytes to seal: bare markdown, or the versioned wrapper when an adjunct rides along. */
export function serializeSealedPayload(contentMarkdown: string, extras?: SealedPayloadExtras): string {
  const attachmentRefs = extras?.attachmentRefs
  const sources = extras?.sources
  const draftContentJson = extras?.draftContentJson
  const hasRefs = attachmentRefs !== undefined && attachmentRefs.length > 0
  const hasSources = sources !== undefined && sources.length > 0
  const hasDraftBody = draftContentJson !== undefined && draftContentJson !== null
  if (!hasRefs && !hasSources && !hasDraftBody) return contentMarkdown
  return JSON.stringify({
    __e2ePayload: E2E_PAYLOAD_VERSION,
    contentMarkdown,
    attachmentRefs: attachmentRefs ?? [],
    ...(hasSources ? { sources } : {}),
    ...(hasDraftBody ? { draftContentJson } : {}),
  } satisfies E2eSealedPayload)
}

export interface ParsedSealedPayload {
  contentMarkdown: string
  attachmentRefs: AttachmentRef[]
  sources: SealedSourceItem[]
  draftContentJson: unknown | null
}

function isAttachmentRef(value: unknown): value is AttachmentRef {
  if (typeof value !== "object" || value === null) return false
  const r = value as Record<string, unknown>
  return (
    typeof r.attachmentId === "string" &&
    typeof r.key === "string" &&
    typeof r.iv === "string" &&
    typeof r.filename === "string" &&
    typeof r.mimeType === "string" &&
    typeof r.sizeBytes === "number"
  )
}

function isSealedSourceItem(value: unknown): value is SealedSourceItem {
  if (typeof value !== "object" || value === null) return false
  const s = value as Record<string, unknown>
  return (
    typeof s.title === "string" &&
    typeof s.url === "string" &&
    (s.type === undefined || typeof s.type === "string") &&
    (s.snippet === undefined || typeof s.snippet === "string")
  )
}

function isDocLike(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false
  const v = value as Record<string, unknown>
  return v.type === "doc" && Array.isArray(v.content)
}

/**
 * Inverse of `serializeSealedPayload`. A decrypted string is either the bare
 * markdown body or the versioned wrapper; anything that doesn't parse as our
 * wrapper is treated as raw markdown so older messages keep opening unchanged.
 */
export function parseSealedPayload(raw: string): ParsedSealedPayload {
  if (raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw) as Partial<E2eSealedPayload>
      if (parsed.__e2ePayload === E2E_PAYLOAD_VERSION && typeof parsed.contentMarkdown === "string") {
        const attachmentRefs = Array.isArray(parsed.attachmentRefs) ? parsed.attachmentRefs.filter(isAttachmentRef) : []
        const sources = Array.isArray(parsed.sources) ? parsed.sources.filter(isSealedSourceItem) : []
        const draftContentJson = isDocLike(parsed.draftContentJson) ? parsed.draftContentJson : null
        return { contentMarkdown: parsed.contentMarkdown, attachmentRefs, sources, draftContentJson }
      }
    } catch {
      // Not our wrapper — fall through and treat the whole string as markdown.
    }
  }
  return { contentMarkdown: raw, attachmentRefs: [], sources: [], draftContentJson: null }
}
