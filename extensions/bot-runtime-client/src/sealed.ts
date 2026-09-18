/**
 * Sealed (E2EE) turn support for bot-runtime harnesses.
 *
 * A harness that serves an end-to-end-encrypted scratchpad holds a keyring of
 * BIKs (Bot Identity Keys): X25519 keypairs the owner wraps the stream's
 * symmetric key (SSK) to. One key per host is the default, so every runtime on
 * a box shares it; a key can also be pinned to a single stream. On a winning
 * claim the backend hands the harness a
 * `sealedContext` — SSK wraps addressed to one of its keys plus the sealed
 * trigger and history ciphertext — and the harness seals every reply and trace step back
 * under the same SSK. The server never sees plaintext (INV-E7); the owner's
 * client opens the harness's output exactly as it opens the enclave's.
 *
 * This module is pure crypto + a small keystore; it does no HTTP. Transport
 * routing lives in `BotRuntimeTransport` (sealed steps) and each harness's own
 * HTTP client (sealed complete / interim messages, low-frequency writes).
 */

import { ulid } from "ulid"
import type { E2eKeyRecord, E2eKeyring } from "./keyring"
import {
  base64ToBytes,
  buildMessageAad,
  buildWrapAad,
  bytesToBase64,
  exportPrivateKey,
  exportPublicKey,
  generateKeyPair,
  generateStreamKey,
  importRecipientPrivateKey,
  importRecipientPublicKey,
  openMessageAsString,
  parseSealedPayload,
  sealMessage,
  serializeSealedPayload,
  unwrapStreamKey,
  wrapStreamKey,
  type WebCryptoKey,
  type AttachmentRef,
  type SealedPayloadExtras,
  type StreamEnvelope,
} from "./crypto"

/**
 * Per-claim secret (model A) the backend hands a sealed turn in `sealedContext`;
 * echoed on every sealed callback so the backend can bind it to that session.
 */
export const THREA_CALLBACK_TOKEN_HEADER = "X-Threa-Callback-Token"

/** This install's registered Bot Identity Key — held in memory; the private key never re-exports once loaded. */
export interface BotIdentityKey {
  publicKeyId: string
  publicKeyBase64: string
  privateKey: WebCryptoKey
}

/** One SSK wrap addressed to this bot's BIK (wire shape from the claim's `sealedContext`). */
export interface SealedSskWrap {
  keyGeneration: number
  wrapEnc: string
  wrapCt: string
}

/** One SSK-sealed message: base64 ciphertext + its envelope (wire shape). */
export interface SealedMessageWire {
  ciphertext: string
  envelope: StreamEnvelope
}

/**
 * The sealed work handed to an owner-granted external bot on a winning claim
 * when the delivery verdict is `sealed`. Mirrors `@threahq/types`' `SealedTurnContext`
 * (which standalone extensions can't import). The backend never decrypts: it
 * ships ciphertext + SSK wraps addressed to this bot's BIK; the bot unwraps
 * with its identity private key, opens history/prompt, runs its turn, and seals
 * each reply/step back under the same SSK.
 */
export interface SealedTurnContext {
  callbackToken: string
  wraps: SealedSskWrap[]
  history: (SealedMessageWire & { role: "user" | "assistant"; sequence: string })[]
  prompt: SealedMessageWire
  reply: { keyGeneration: number; senderId: string }
  trigger?: { messageId: string; authorName: string; authorType: string; createdAt: string }
}

/** Everything a sealed turn needs to seal its replies/steps back under the stream key. */
export interface SealingState {
  /** E2E root stream id — bound into every wrap/message/step AAD. */
  streamId: string
  replyKeyGeneration: number
  replySenderId: string
  /** The recovered SSK for `replyKeyGeneration`; replies and steps seal under it. */
  replySsk: Uint8Array
  callbackToken: string
}

/** One decrypted prior message, oldest→newest. Formatting into a prompt is the harness's job. */
export interface DecryptedHistoryItem {
  role: "user" | "assistant"
  sequence: string
  contentMarkdown: string
  /** Per-file keys for the message's E2E attachments — download + decrypt is the harness's job. */
  attachmentRefs: AttachmentRef[]
}

export interface OpenedSealedTurn {
  promptMarkdown: string
  /** Refs sealed into the trigger message's payload (the files attached to the request itself). */
  promptAttachmentRefs: AttachmentRef[]
  history: DecryptedHistoryItem[]
  sealing: SealingState
}

/** The body of a sealed reply or interim message: `msg_…` id in clear, content sealed. */
export interface SealedReplyBody {
  messageId: string
  ciphertext: string
  envelope: StreamEnvelope
}

/** One sealed trace step (the `/sealed-steps` wire shape; `stepId` keys the row, content is ciphertext). */
export interface SealedStepFrame {
  stepId: string
  stepType: string
  messageId?: string
  ciphertext: string
  envelope: StreamEnvelope
  durationMs?: number
}

// ── keyring ───────────────────────────────────────────────────────────────────

/** Mint a fresh identity key record: a `bik_…` id and an X25519 keypair, base64. */
export async function mintE2eKeyRecord(): Promise<E2eKeyRecord> {
  const keyPair = await generateKeyPair()
  return {
    keyId: `bik_${ulid()}`,
    publicKey: bytesToBase64(await exportPublicKey(keyPair.publicKey)),
    privateKey: bytesToBase64(await exportPrivateKey(keyPair.privateKey)),
  }
}

/**
 * This install's identity keys, ready to open sealed turns. The records live in
 * an {@link E2eKeyring} (keychain or file); this adds the WebCrypto import and
 * caches the result for the process.
 *
 * The public halves must ride EVERY `bot:hello` and presence update: the
 * server reads an advertised keyring as the instance's complete set, so a
 * heartbeat that omits it unregisters every key and breaks sealed-claim wrap
 * coverage.
 */
export class BotKeyring {
  private readonly buildRecords: () => E2eKeyring
  private readonly log: (message: string) => void
  private records: E2eKeyring | undefined
  private cached: BotIdentityKey[] = []
  private inFlight: Promise<BotIdentityKey[]> | undefined
  private loaded = false

  constructor(opts: { keyring: () => E2eKeyring; log?: (message: string) => void }) {
    this.buildRecords = opts.keyring
    this.log = opts.log ?? ((message) => console.error(message))
  }

  /** The loaded keys, if `ensure()` has resolved. */
  get identities(): BotIdentityKey[] {
    return this.cached
  }

  /**
   * Load or create this install's keys, caching them for the process. Returns
   * an empty keyring when the store or WebCrypto fails, logged loudly: the
   * harness then serves plaintext streams only, rather than sealed turns
   * becoming unservable with no clue why. Nothing is downgraded by that — a
   * runtime with no registered key cannot claim a sealed stream at all.
   */
  async ensure(): Promise<BotIdentityKey[]> {
    if (this.loaded) return this.cached
    // Boot presence and `bot:hello` both ensure; without this they would each
    // mint past the cache check and race the store.
    this.inFlight ??= this.load()
      .catch((error) => {
        this.log(`Threa sealed: key load/create failed; sealed scratchpads are unavailable: ${String(error)}`)
        return [] as BotIdentityKey[]
      })
      .finally(() => {
        this.inFlight = undefined
      })
    this.cached = await this.inFlight
    this.loaded = this.cached.length > 0
    return this.cached
  }

  /** The fields to spread into every `bot:hello` and presence body. Empty until `ensure()` resolves. */
  presenceFields(): ReturnType<E2eKeyring["presenceFields"]> {
    return this.records?.presenceFields() ?? {}
  }

  private async load(): Promise<BotIdentityKey[]> {
    this.records ??= this.buildRecords()
    const records = await this.records.ensure()
    const identities: BotIdentityKey[] = []
    for (const record of records) {
      identities.push({
        publicKeyId: record.keyId,
        publicKeyBase64: record.publicKey,
        privateKey: await importRecipientPrivateKey(base64ToBytes(record.privateKey)),
      })
    }
    return identities
  }
}

// ── sealed claim wire validation ─────────────────────────────────────────────

function isEnvelope(value: unknown): value is StreamEnvelope {
  if (typeof value !== "object" || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.v === "number" &&
    typeof v.keyGeneration === "number" &&
    typeof v.iv === "string" &&
    typeof v.aad === "string"
  )
}

function isSealedMessage(value: unknown): value is SealedMessageWire {
  if (typeof value !== "object" || value === null) return false
  const m = value as Record<string, unknown>
  return typeof m.ciphertext === "string" && isEnvelope(m.envelope)
}

/**
 * Validate a claim response's `sealedContext` field. The claim body is untyped
 * JSON at the harness boundary; a malformed context returns `undefined` so the
 * caller can fail the invocation loudly instead of crashing mid-hydration.
 */
export function parseSealedTurnContext(raw: unknown): SealedTurnContext | undefined {
  if (typeof raw !== "object" || raw === null) return undefined
  const c = raw as Record<string, unknown>
  if (typeof c.callbackToken !== "string" || c.callbackToken.length === 0) return undefined
  if (!Array.isArray(c.wraps)) return undefined
  const wraps: SealedSskWrap[] = []
  for (const wrap of c.wraps) {
    if (typeof wrap !== "object" || wrap === null) return undefined
    const w = wrap as Record<string, unknown>
    if (typeof w.keyGeneration !== "number" || typeof w.wrapEnc !== "string" || typeof w.wrapCt !== "string") {
      return undefined
    }
    wraps.push({ keyGeneration: w.keyGeneration, wrapEnc: w.wrapEnc, wrapCt: w.wrapCt })
  }
  if (!isSealedMessage(c.prompt)) return undefined
  const reply = c.reply as Record<string, unknown> | undefined
  if (!reply || typeof reply.keyGeneration !== "number" || typeof reply.senderId !== "string") return undefined
  const history: SealedTurnContext["history"] = []
  if (c.history !== undefined) {
    if (!Array.isArray(c.history)) return undefined
    for (const item of c.history) {
      if (!isSealedMessage(item)) return undefined
      const h = item as unknown as Record<string, unknown>
      const role = h.role === "assistant" ? "assistant" : "user"
      history.push({
        ciphertext: (item as SealedMessageWire).ciphertext,
        envelope: (item as SealedMessageWire).envelope,
        role,
        sequence: typeof h.sequence === "string" ? h.sequence : "0",
      })
    }
  }
  const trigger = c.trigger as Record<string, unknown> | undefined
  return {
    callbackToken: c.callbackToken,
    wraps,
    history,
    prompt: c.prompt,
    reply: { keyGeneration: reply.keyGeneration, senderId: reply.senderId },
    ...(trigger &&
    typeof trigger.messageId === "string" &&
    typeof trigger.authorName === "string" &&
    typeof trigger.authorType === "string" &&
    typeof trigger.createdAt === "string"
      ? {
          trigger: {
            messageId: trigger.messageId,
            authorName: trigger.authorName,
            authorType: trigger.authorType,
            createdAt: trigger.createdAt,
          },
        }
      : {}),
  }
}

// ── sealed turn crypto (pure; no module state or I/O) ─────────────────────────

/**
 * Recover one wrap's stream key with whichever of this runtime's keys it was
 * addressed to. The wire wraps carry no recipient id, so the holder of a
 * keyring has to try: the wrap AAD binds the key id, so every key but the right
 * one fails to authenticate. A wrap nothing opens is a generation this runtime
 * was not invited to, which is why the miss is `undefined` and not a throw.
 */
async function unwrapWithAny(params: {
  wrap: SealedSskWrap
  identities: BotIdentityKey[]
  streamId: string
}): Promise<Uint8Array | undefined> {
  const { wrap, identities, streamId } = params
  for (const identity of identities) {
    try {
      return await unwrapStreamKey({
        enc: base64ToBytes(wrap.wrapEnc),
        ct: base64ToBytes(wrap.wrapCt),
        recipientPrivateKey: identity.privateKey,
        aad: buildWrapAad({ streamId, keyGeneration: wrap.keyGeneration, recipientKeyId: identity.publicKeyId }),
      })
    } catch {
      continue
    }
  }
  return undefined
}

/**
 * Open a sealed claim with this bot's keyring: recover the SSK for every generation
 * the backend wrapped to us (AAD-bound to our key id), open the trigger + prior
 * history, and return the decrypted prompt plus the {@link SealingState} the turn
 * seals replies/steps with. `streamId` is the E2E root stream — wraps and the
 * owner's message AAD both bind to it. A wrap or history row we can't open is
 * skipped (a generation predating our invite), never fatal; a missing reply or
 * prompt key is fatal (the turn can't be served).
 */
export async function openSealedTurnContext(params: {
  sealed: SealedTurnContext
  identities: BotIdentityKey[]
  streamId: string
}): Promise<OpenedSealedTurn> {
  const { sealed, identities, streamId } = params
  const sskByGeneration = new Map<number, Uint8Array>()
  for (const wrap of sealed.wraps) {
    const ssk = await unwrapWithAny({ wrap, identities, streamId })
    if (ssk) sskByGeneration.set(wrap.keyGeneration, ssk)
  }

  const promptSsk = sskByGeneration.get(sealed.prompt.envelope.keyGeneration)
  if (!promptSsk) throw new Error("Sealed claim: no SSK wrap for the prompt's key generation")
  const promptRaw = await openMessageAsString({
    key: promptSsk,
    envelope: sealed.prompt.envelope,
    ciphertext: base64ToBytes(sealed.prompt.ciphertext),
  })
  const promptPayload = parseSealedPayload(promptRaw)

  const replySsk = sskByGeneration.get(sealed.reply.keyGeneration)
  if (!replySsk) throw new Error("Sealed claim: no SSK wrap for the reply's key generation")

  const history: DecryptedHistoryItem[] = []
  for (const item of sealed.history) {
    const ssk = sskByGeneration.get(item.envelope.keyGeneration)
    if (!ssk) continue
    try {
      const raw = await openMessageAsString({
        key: ssk,
        envelope: item.envelope,
        ciphertext: base64ToBytes(item.ciphertext),
      })
      const payload = parseSealedPayload(raw)
      history.push({
        role: item.role,
        sequence: item.sequence,
        contentMarkdown: payload.contentMarkdown,
        attachmentRefs: payload.attachmentRefs,
      })
    } catch {
      continue
    }
  }

  return {
    promptMarkdown: promptPayload.contentMarkdown,
    promptAttachmentRefs: promptPayload.attachmentRefs,
    history,
    sealing: {
      streamId,
      replyKeyGeneration: sealed.reply.keyGeneration,
      replySenderId: sealed.reply.senderId,
      replySsk,
      callbackToken: sealed.callbackToken,
    },
  }
}

/**
 * Seal a reply (or interim message) under the stream key, bound to a fresh
 * `msg_…` id — the body of the sealed `/complete` reply and of a sealed
 * interim `/sealed-messages` post.
 */
export async function sealReply(
  sealing: SealingState,
  markdown: string,
  extras?: SealedPayloadExtras
): Promise<SealedReplyBody> {
  const messageId = `msg_${ulid()}`
  const sealed = await sealMessage({
    key: sealing.replySsk,
    keyGeneration: sealing.replyKeyGeneration,
    payload: serializeSealedPayload(markdown, extras),
    aad: buildMessageAad({ streamId: sealing.streamId, messageId, senderId: sealing.replySenderId }),
  })
  return { messageId, ciphertext: bytesToBase64(sealed.ciphertext), envelope: sealed.envelope }
}

/**
 * Seal one trace step under the stream key, bound to a fresh `step_…` id — the
 * sealed `/steps` wire shape. The `step_…` id rides the `messageId` slot of the
 * message AAD, exactly as the enclave's trace-observer binds its steps.
 * Content is sealed as-given: clamping oversized tool output is the caller's
 * policy, not hidden truncation here.
 */
export async function sealStep(
  sealing: SealingState,
  stepType: string,
  content: string,
  opts?: { durationMs?: number }
): Promise<SealedStepFrame> {
  const stepId = `step_${ulid()}`
  const sealed = await sealMessage({
    key: sealing.replySsk,
    keyGeneration: sealing.replyKeyGeneration,
    payload: serializeSealedPayload(content),
    aad: buildMessageAad({ streamId: sealing.streamId, messageId: stepId, senderId: sealing.replySenderId }),
  })
  return {
    stepId,
    stepType,
    ciphertext: bytesToBase64(sealed.ciphertext),
    envelope: sealed.envelope,
    ...(opts?.durationMs !== undefined ? { durationMs: opts.durationMs } : {}),
  }
}

/** Error text for a sealed `/fail`: class name only, never the message — it could echo decrypted content. */
export function scrubSealedError(error: unknown): string {
  return error instanceof Error ? error.name || "Error" : "Error"
}

// ── session-control sealed ack ────────────────────────────────────────────────

/**
 * The minimal sealed material a claim carries for a session-control command
 * (e.g. `/model`) on an E2E scratchpad: the current-generation SSK wraps
 * addressed to this bot's BIK plus the reply binding. No trigger/history — the
 * command name is cleartext dispatch metadata, so only the ack needs sealing.
 * Absent when the bot can't seal (no key / wrap race); the harness then closes
 * the command silently.
 */
export interface SealedAckContext {
  wraps: SealedSskWrap[]
  reply: { keyGeneration: number; senderId: string }
}

/** Validate a claim's `sealedAck` field (untyped JSON at the harness boundary). */
export function parseSealedAckContext(raw: unknown): SealedAckContext | undefined {
  if (typeof raw !== "object" || raw === null) return undefined
  const c = raw as Record<string, unknown>
  if (!Array.isArray(c.wraps)) return undefined
  const wraps: SealedSskWrap[] = []
  for (const wrap of c.wraps) {
    if (typeof wrap !== "object" || wrap === null) return undefined
    const w = wrap as Record<string, unknown>
    if (typeof w.keyGeneration !== "number" || typeof w.wrapEnc !== "string" || typeof w.wrapCt !== "string") {
      return undefined
    }
    wraps.push({ keyGeneration: w.keyGeneration, wrapEnc: w.wrapEnc, wrapCt: w.wrapCt })
  }
  const reply = c.reply as Record<string, unknown> | undefined
  if (!reply || typeof reply.keyGeneration !== "number" || typeof reply.senderId !== "string") return undefined
  return { wraps, reply: { keyGeneration: reply.keyGeneration, senderId: reply.senderId } }
}

/**
 * Open a session-control sealed ack: unwrap the SSK for the reply generation
 * with this bot's BIK and return the {@link SealingState} `sealReply` seals the
 * ack with. `callbackToken` is empty — a session-control ack authorizes with the
 * claim token on `/complete`, not a per-turn callback token. Throws when no wrap
 * covers the reply generation (a key race); the caller falls back to a silent close.
 */
export async function openSealedAck(params: {
  ack: SealedAckContext
  identities: BotIdentityKey[]
  streamId: string
}): Promise<SealingState> {
  const { ack, identities, streamId } = params
  let replySsk: Uint8Array | undefined
  for (const wrap of ack.wraps) {
    if (wrap.keyGeneration !== ack.reply.keyGeneration) continue
    replySsk = await unwrapWithAny({ wrap, identities, streamId })
    if (replySsk) break
  }
  if (!replySsk) throw new Error("Sealed ack: no SSK wrap for the reply's key generation")
  return {
    streamId,
    replyKeyGeneration: ack.reply.keyGeneration,
    replySenderId: ack.reply.senderId,
    replySsk,
    callbackToken: "",
  }
}

// ── stream-key provisioning (harness-created E2E scratchpads) ─────────────────

/** One recipient a freshly-minted stream key is wrapped to. */
export interface ProvisionRecipient {
  recipientKind: "user" | "bot"
  /** UIK/BIK key id — the AAD binds the wrap to this slot. */
  recipientKeyId: string
  /** Base64 raw X25519 public key. */
  publicKeyBase64: string
}

export interface ProvisionedWrap {
  recipientKind: "user" | "bot"
  recipientKeyId: string
  wrapEnc: string
  wrapCt: string
}

/**
 * Mint a fresh generation-0 stream key for a harness-created E2E scratchpad and
 * wrap it to each recipient (the owner's UIK + this install's BIK) — the wire
 * body of the phase-two provisioning POST. The SSK itself is returned only so
 * the caller can drop it deliberately: future turns recover it from the claim's
 * wraps, so nothing needs (or should) persist it locally.
 */
export async function mintStreamKeyWraps(params: {
  streamId: string
  keyGeneration: number
  recipients: ProvisionRecipient[]
}): Promise<{ wraps: ProvisionedWrap[] }> {
  const ssk = generateStreamKey()
  const wraps: ProvisionedWrap[] = []
  for (const recipient of params.recipients) {
    const publicKey = await importRecipientPublicKey(base64ToBytes(recipient.publicKeyBase64))
    const wrapped = await wrapStreamKey({
      key: ssk,
      recipientPublicKey: publicKey,
      aad: buildWrapAad({
        streamId: params.streamId,
        keyGeneration: params.keyGeneration,
        recipientKeyId: recipient.recipientKeyId,
      }),
    })
    wraps.push({
      recipientKind: recipient.recipientKind,
      recipientKeyId: recipient.recipientKeyId,
      wrapEnc: bytesToBase64(wrapped.enc),
      wrapCt: bytesToBase64(wrapped.ct),
    })
  }
  return { wraps }
}
