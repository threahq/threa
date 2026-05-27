import { parseMarkdown } from "@threa/prosemirror"
import type { JSONContent } from "@tiptap/react"
import { buildMessageAad, decryptPayloadAsString, encryptPayload, ENVELOPE_VERSION, type Envelope } from "./envelope"

// The placeholder text the backend stores in `contentMarkdown` / `contentJson`
// for E2E messages is the single source of truth in @threa/types so the
// backend insert path and the frontend decrypt path stay byte-identical.
// Re-exported so callers of this module don't have to cross the type-barrier
// for both the envelope helpers and the placeholder constant.
export { E2E_PLACEHOLDER_CONTENT_MARKDOWN } from "@threa/types"

export interface EncryptMessageInput {
  contentMarkdown: string
  streamId: string
  messageId: string
  senderId: string
  recipientKeyId: string
  recipientPublicKey: Uint8Array
}

export interface EncryptMessageResult {
  /** Base64 ciphertext (mirrors `envelope.ciphertext` — duplicated so the wire payload can carry both fields explicitly). */
  ciphertext: string
  envelope: Envelope
  e2eVersion: number
}

/**
 * Encrypt a message's markdown body to a single recipient. Phase-1 MVP only
 * supports the owner-as-sole-recipient case (the scratchpad creator encrypts
 * to their own UIK pubkey), so this stays a one-recipient call — multi-party
 * sharing is a follow-up that will accept an array here.
 */
export async function encryptMessage(input: EncryptMessageInput): Promise<EncryptMessageResult> {
  const aad = buildMessageAad({
    streamId: input.streamId,
    messageId: input.messageId,
    senderId: input.senderId,
  })
  const { envelope } = await encryptPayload({
    payload: input.contentMarkdown,
    recipients: [{ recipientKeyId: input.recipientKeyId, publicKey: input.recipientPublicKey }],
    aad,
  })
  return { ciphertext: envelope.ciphertext, envelope, e2eVersion: ENVELOPE_VERSION }
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

/**
 * Read a wire envelope off an inbound message payload and decrypt it into
 * plaintext + parsed JSONContent. Returns `null` when:
 *  - the payload has no ciphertext (plaintext message)
 *  - the envelope can't be parsed
 *  - decryption throws (wrong recipient, tampered AAD, locked session)
 *
 * Callers should fall back to the existing `contentMarkdown` placeholder when
 * this returns `null` so the UI still has something to render.
 */
export async function tryDecryptMessagePayload(
  payload: DecryptMessagePayload,
  opts: { privateKey: CryptoKey; recipientKeyId: string }
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

function parseEnvelope(raw: unknown): Envelope | null {
  if (!raw || typeof raw !== "object") return null
  const candidate = raw as Partial<Envelope>
  if (
    typeof candidate.v !== "number" ||
    typeof candidate.ciphertext !== "string" ||
    typeof candidate.iv !== "string" ||
    typeof candidate.aad !== "string" ||
    !Array.isArray(candidate.recipients)
  ) {
    return null
  }
  return candidate as Envelope
}
