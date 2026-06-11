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
  parseSealedPayload,
  sealMessage,
  serializeSealedPayload,
  STREAM_ENVELOPE_VERSION,
  type AttachmentRef,
  type Envelope,
  type SealedSourceItem,
  type StreamEnvelope,
} from "@threa/crypto"
import { resolveStreamKey } from "./stream-key-cache"

// Parsing/serializing the sealed payload (and the AttachmentRef shape) is shared
// crypto so the enclave strips the same wrapper (INV-35). Re-export the parser
// and its result type for callers that import them from this module.
export { parseSealedPayload, type ParsedSealedPayload } from "@threa/crypto"

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
  /**
   * E2E attachments to seal into the payload. Their per-attachment key/iv and
   * real filename/mime/size ride here (inside the SSK ciphertext), never on the
   * wire — the server only holds opaque bytes and a placeholder row.
   */
  attachmentRefs?: AttachmentRef[]
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
    payload: serializeSealedPayload(input.contentMarkdown, input.attachmentRefs),
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
      streamId: opts.rootStreamId ?? opts.streamId,
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
  /**
   * E2E attachments sealed in the payload. Optional so the many call sites that
   * construct bare `{contentMarkdown, contentJson}` (and the v1 path) stay valid;
   * the v2 decrypt always populates it, and readers default to `[]`.
   */
  attachmentRefs?: AttachmentRef[]
  /**
   * Citation sources sealed in the payload (agent replies). Same optionality
   * contract as `attachmentRefs` — the v2 decrypt always populates it, readers
   * default to `[]`. Sources only ever exist inside the ciphertext (E2EE-9).
   */
  sources?: SealedSourceItem[]
}

export interface DecryptMessageOpts {
  /** The viewer's unwrapped UIK private key. */
  privateKey: CryptoKey
  /** The viewer's UIK key id — selects the v1 recipient slot / v2 wrap row. */
  recipientKeyId: string
  workspaceId: string
  streamId: string
  /**
   * The stream whose SSK wraps seal this message — the root for a thread, which
   * shares its root scratchpad's key. A thread carries no wraps of its own, so
   * the SSK is resolved against the root (the wrap AAD is bound to the root id).
   * Defaults to `streamId` (a top-level stream is its own root).
   */
  rootStreamId?: string
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
      streamId: opts.rootStreamId ?? opts.streamId,
      keyGeneration: env.keyGeneration,
      recipientKeyId: opts.recipientKeyId,
      privateKey: opts.privateKey,
    })
    if (!ssk) return null
    const raw = await openMessageAsString({
      key: ssk,
      envelope: env,
      ciphertext: base64ToBytes(payload.ciphertext),
    })
    // The decrypted bytes are either the bare markdown body or the versioned
    // wrapper carrying attachmentRefs + citation sources. Surface all of it:
    // the markdown for the body, the refs (key/iv/filename/mime) so the viewer
    // can fetch + decrypt the opaque S3 ciphertext on view, and the sources so
    // an agent reply renders its citations (E2EE-9).
    const { contentMarkdown, attachmentRefs, sources } = parseSealedPayload(raw)
    return { contentMarkdown, contentJson: parseMarkdown(contentMarkdown), attachmentRefs, sources }
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
    // The v1 fan-out path predates E2E attachments and sources — nothing to surface.
    return { contentMarkdown: markdown, contentJson: parseMarkdown(markdown), attachmentRefs: [], sources: [] }
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
