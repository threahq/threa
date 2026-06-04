import { parseMarkdown } from "@threa/prosemirror"
import type { JSONContent } from "@tiptap/react"
import {
  base64ToBytes,
  buildMessageAad,
  buildNameAad,
  bytesToBase64,
  decryptPayloadAsString,
  ENVELOPE_VERSION,
  openMessageAsString,
  sealMessage,
  STREAM_ENVELOPE_VERSION,
  type Envelope,
  type StreamEnvelope,
} from "@threa/crypto"
import { resolveStreamKey } from "./stream-key-cache"

// The placeholder text the backend stores in `contentMarkdown` / `contentJson`
// for E2E messages is the single source of truth in @threa/types so the
// backend insert path and the frontend decrypt path stay byte-identical.
// Re-exported so callers of this module don't have to cross the type-barrier
// for both the envelope helpers and the placeholder constant.
export { E2E_PLACEHOLDER_CONTENT_MARKDOWN } from "@threa/types"

export interface SealStreamMessageInput {
  contentMarkdown: string
  streamId: string
  messageId: string
  senderId: string
  /** 32-byte SSK for `keyGeneration` — held in memory by the stream-key cache. */
  ssk: Uint8Array
  keyGeneration: number
}

export interface SealStreamMessageResult {
  /** Base64 AES-256-GCM ciphertext (stored on the wire in `messages.ciphertext`). */
  ciphertext: string
  envelope: StreamEnvelope
  e2eVersion: number
}

/**
 * Seal a message's markdown body under the stream's symmetric key (SSK, v2).
 * The SSK is shared by every recipient of the stream's current generation, so
 * unlike the v1 fan-out this carries no recipient list — authorization lives
 * out of band in the stream's key wraps. Recipients open it by resolving the
 * SSK for `envelope.keyGeneration` (see `resolveStreamKey`).
 */
export async function sealStreamMessage(input: SealStreamMessageInput): Promise<SealStreamMessageResult> {
  const aad = buildMessageAad({
    streamId: input.streamId,
    messageId: input.messageId,
    senderId: input.senderId,
  })
  const { envelope, ciphertext } = await sealMessage({
    key: input.ssk,
    keyGeneration: input.keyGeneration,
    payload: input.contentMarkdown,
    aad,
  })
  return { ciphertext: bytesToBase64(ciphertext), envelope, e2eVersion: STREAM_ENVELOPE_VERSION }
}

/**
 * Seal a stream's display name under its SSK, bound to `(streamId, "name",
 * generation)` so a malicious server can't relocate it onto another stream or
 * swap it with a message body. Stored alongside the plaintext `displayName`
 * (which stays the locked-state fallback); an unlocked client prefers this
 * tamper-evident copy. Reuses the same SSK ciphertext path as messages.
 */
export async function sealStreamName(input: {
  name: string
  streamId: string
  ssk: Uint8Array
  keyGeneration: number
}): Promise<{ ciphertext: string; envelope: StreamEnvelope }> {
  const aad = buildNameAad({ streamId: input.streamId, keyGeneration: input.keyGeneration })
  const { envelope, ciphertext } = await sealMessage({
    key: input.ssk,
    keyGeneration: input.keyGeneration,
    payload: input.name,
    aad,
  })
  return { ciphertext: bytesToBase64(ciphertext), envelope }
}

/**
 * Open a sealed stream name. Resolves the SSK for the envelope's generation via
 * the stream's wraps and decrypts. Returns null when there's no sealed name, the
 * envelope is unparseable, the SSK can't be resolved (not a recipient / locked),
 * or the AAD is forged — callers fall back to the plaintext name.
 */
export async function tryOpenStreamName(
  payload: { ciphertext?: string | null; envelope?: unknown },
  opts: DecryptMessageOpts
): Promise<string | null> {
  const env = parseStreamEnvelope(payload.envelope)
  if (!env || typeof payload.ciphertext !== "string") return null
  try {
    const ssk = await resolveStreamKey({
      workspaceId: opts.workspaceId,
      streamId: opts.streamId,
      keyGeneration: env.keyGeneration,
      recipientKeyId: opts.recipientKeyId,
      privateKey: opts.privateKey,
    })
    if (!ssk) return null
    return await openMessageAsString({ key: ssk, envelope: env, ciphertext: base64ToBytes(payload.ciphertext) })
  } catch {
    return null
  }
}

export interface DecryptMessagePayload {
  /** Server-set placeholder (zero-width space) — left in place if decryption fails. */
  contentMarkdown: string
  contentJson?: JSONContent
  ciphertext?: string
  envelope?: unknown
  e2eVersion?: number
}

export interface DecryptedMessageContent {
  contentMarkdown: string
  contentJson: JSONContent
}

export interface DecryptMessageOpts {
  /** The viewer's unwrapped UIK private key. */
  privateKey: CryptoKey
  /** The viewer's UIK key id — selects the v1 recipient slot / v2 wrap row. */
  recipientKeyId: string
  workspaceId: string
  streamId: string
}

/**
 * Read a wire envelope off an inbound message payload and decrypt it into
 * plaintext + parsed JSONContent. Routes on the envelope version: v2 opens the
 * SSK-sealed ciphertext (resolving the stream key via its wraps), v1 unwraps
 * the legacy per-message recipient fan-out. Returns `null` when:
 *  - the payload has no envelope (plaintext message)
 *  - the envelope can't be parsed / has an unknown version
 *  - decryption throws (wrong recipient, tampered AAD, locked session)
 *  - the SSK can't be resolved (not a recipient of that generation)
 *
 * Callers should fall back to the existing `contentMarkdown` placeholder when
 * this returns `null` so the UI still has something to render.
 */
export async function tryDecryptMessagePayload(
  payload: DecryptMessagePayload,
  opts: DecryptMessageOpts
): Promise<DecryptedMessageContent | null> {
  const version = readEnvelopeVersion(payload.envelope)
  if (version === STREAM_ENVELOPE_VERSION) {
    return tryOpenStreamMessage(payload, opts)
  }
  return tryDecryptFanoutMessage(payload, opts)
}

/** v2: open an SSK-sealed message. */
async function tryOpenStreamMessage(
  payload: DecryptMessagePayload,
  opts: DecryptMessageOpts
): Promise<DecryptedMessageContent | null> {
  const env = parseStreamEnvelope(payload.envelope)
  if (!env || typeof payload.ciphertext !== "string") return null
  try {
    const ssk = await resolveStreamKey({
      workspaceId: opts.workspaceId,
      streamId: opts.streamId,
      keyGeneration: env.keyGeneration,
      recipientKeyId: opts.recipientKeyId,
      privateKey: opts.privateKey,
    })
    if (!ssk) return null
    const markdown = await openMessageAsString({
      key: ssk,
      envelope: env,
      ciphertext: base64ToBytes(payload.ciphertext),
    })
    return { contentMarkdown: markdown, contentJson: parseMarkdown(markdown) }
  } catch {
    return null
  }
}

/** v1: unwrap the legacy per-message recipient fan-out envelope (read-only). */
async function tryDecryptFanoutMessage(
  payload: DecryptMessagePayload,
  opts: DecryptMessageOpts
): Promise<DecryptedMessageContent | null> {
  const env = parseEnvelope(payload.envelope)
  if (!env) return null
  try {
    const markdown = await decryptPayloadAsString({
      envelope: env,
      privateKey: opts.privateKey,
      recipientKeyId: opts.recipientKeyId,
    })
    return { contentMarkdown: markdown, contentJson: parseMarkdown(markdown) }
  } catch {
    return null
  }
}

function readEnvelopeVersion(raw: unknown): number | null {
  if (!raw || typeof raw !== "object") return null
  const v = (raw as { v?: unknown }).v
  return typeof v === "number" ? v : null
}

function parseStreamEnvelope(raw: unknown): StreamEnvelope | null {
  if (!raw || typeof raw !== "object") return null
  const candidate = raw as Partial<StreamEnvelope>
  if (
    candidate.v !== STREAM_ENVELOPE_VERSION ||
    typeof candidate.keyGeneration !== "number" ||
    typeof candidate.iv !== "string" ||
    typeof candidate.aad !== "string"
  ) {
    return null
  }
  return candidate as StreamEnvelope
}

function parseEnvelope(raw: unknown): Envelope | null {
  if (!raw || typeof raw !== "object") return null
  const candidate = raw as Partial<Envelope>
  if (
    candidate.v !== ENVELOPE_VERSION ||
    typeof candidate.ciphertext !== "string" ||
    typeof candidate.iv !== "string" ||
    typeof candidate.aad !== "string" ||
    !Array.isArray(candidate.recipients)
  ) {
    return null
  }
  return candidate as Envelope
}
