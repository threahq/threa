/**
 * Sealed (E2EE) turn support for bot-runtime harnesses.
 *
 * A harness that serves an end-to-end-encrypted scratchpad holds a BIK (Bot
 * Identity Key): a per-install X25519 keypair the owner wraps the stream's
 * symmetric key (SSK) to. On a winning claim the backend hands the harness a
 * `sealedContext` — SSK wraps addressed to its BIK plus the sealed trigger and
 * history ciphertext — and the harness seals every reply and trace step back
 * under the same SSK. The server never sees plaintext (INV-E7); the owner's
 * client opens the harness's output exactly as it opens the enclave's.
 *
 * This module is pure crypto + a small keystore; it does no HTTP. Transport
 * routing lives in `BotRuntimeTransport` (sealed steps) and each harness's own
 * HTTP client (sealed complete / interim messages, low-frequency writes).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { ulid } from "ulid"
import {
  base64ToBytes,
  buildMessageAad,
  buildWrapAad,
  bytesToBase64,
  exportPrivateKey,
  exportPublicKey,
  generateKeyPair,
  importRecipientPrivateKey,
  openMessageAsString,
  parseSealedPayload,
  sealMessage,
  serializeSealedPayload,
  unwrapStreamKey,
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
  privateKey: CryptoKey
}

interface PersistedBik {
  publicKeyId: string
  publicKey: string
  privateKey: string
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
 * when the delivery verdict is `sealed`. Mirrors `@threa/types`' `SealedTurnContext`
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
}

export interface OpenedSealedTurn {
  promptMarkdown: string
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

// ── BIK keystore ──────────────────────────────────────────────────────────────

/**
 * Loads (or generates + persists) a harness install's BIK. The keypair is
 * persisted separately from the config (private key material, mode `0600`) and
 * stable across restarts — the owner's wraps target its `publicKeyId`, so
 * rotating it would orphan every wrap. Generate lazily before the first
 * presence write; the public half must ride EVERY `bot:hello` and presence
 * update (the backend's `bot_runtime_instances` upsert overwrites the stored
 * key by default, so a heartbeat that omits it clears the registration and
 * breaks sealed-claim wrap coverage).
 */
export class BikKeystore {
  private readonly path: string
  private readonly log: (message: string) => void
  private cached: BotIdentityKey | undefined
  private inFlight: Promise<BotIdentityKey | undefined> | undefined

  constructor(opts: { path: string; log?: (message: string) => void }) {
    this.path = opts.path
    this.log = opts.log ?? ((message) => console.error(message))
  }

  /** The loaded BIK, if `ensure()` has resolved. */
  get current(): BotIdentityKey | undefined {
    return this.cached
  }

  /**
   * Load or create this install's BIK, caching it for the process. Returns
   * `undefined` on a catastrophic failure (WebCrypto without X25519, say) — the
   * harness then runs plaintext-only, with the failure logged loudly rather
   * than sealed turns becoming mysteriously unservable with no clue why.
   */
  async ensure(): Promise<BotIdentityKey | undefined> {
    if (this.cached) return this.cached
    // Concurrent callers (boot presence + bot:hello, say) would otherwise each
    // mint a keypair past the cache check and race the persist.
    this.inFlight ??= this.load()
      .catch((error) => {
        this.log(`Threa sealed: BIK load/create threw: ${String(error)}`)
        return undefined
      })
      .finally(() => {
        this.inFlight = undefined
      })
    this.cached = await this.inFlight
    return this.cached
  }

  /**
   * The `publicKey`/`publicKeyId` fields to spread into every `bot:hello` and
   * presence body. Empty until `ensure()` resolves — callers ensure at boot.
   */
  presenceFields(): { publicKey: string; publicKeyId: string } | Record<string, never> {
    return this.cached ? { publicKey: this.cached.publicKeyBase64, publicKeyId: this.cached.publicKeyId } : {}
  }

  private async load(): Promise<BotIdentityKey | undefined> {
    const persisted = this.readPersisted()
    if (persisted) {
      try {
        return {
          publicKeyId: persisted.publicKeyId,
          publicKeyBase64: persisted.publicKey,
          privateKey: await importRecipientPrivateKey(base64ToBytes(persisted.privateKey)),
        }
      } catch (error) {
        this.log(`Threa sealed: failed to import BIK from ${this.path}; generating a fresh one: ${String(error)}`)
      }
    }
    return this.create()
  }

  private readPersisted(): PersistedBik | undefined {
    if (!existsSync(this.path)) return undefined
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<PersistedBik>
      if (
        typeof parsed.publicKeyId === "string" &&
        typeof parsed.publicKey === "string" &&
        typeof parsed.privateKey === "string"
      ) {
        return parsed as PersistedBik
      }
      this.log(`Threa sealed: ${this.path} is malformed; generating a fresh BIK`)
      return undefined
    } catch (error) {
      this.log(`Threa sealed: failed to parse ${this.path}: ${String(error)}`)
      return undefined
    }
  }

  private async create(): Promise<BotIdentityKey | undefined> {
    let keyPair: CryptoKeyPair
    let publicKeyBase64: string
    let privateKeyBase64: string
    try {
      keyPair = await generateKeyPair()
      publicKeyBase64 = bytesToBase64(await exportPublicKey(keyPair.publicKey))
      privateKeyBase64 = bytesToBase64(await exportPrivateKey(keyPair.privateKey))
    } catch (error) {
      this.log(`Threa sealed: failed to generate a BIK; sealed scratchpads are unavailable: ${String(error)}`)
      return undefined
    }
    const record: PersistedBik = {
      publicKeyId: `bik_${ulid()}`,
      publicKey: publicKeyBase64,
      privateKey: privateKeyBase64,
    }
    // A persist failure is survivable (in-memory key serves sealed turns this
    // session); only restart-stability suffers, so log rather than fail.
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      writeFileSync(this.path, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
    } catch (error) {
      this.log(
        `Threa sealed: failed to persist BIK to ${this.path}; using an in-memory key this session: ${String(error)}`
      )
    }
    return {
      publicKeyId: record.publicKeyId,
      publicKeyBase64,
      privateKey: keyPair.privateKey,
    }
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
 * Open a sealed claim with this bot's BIK: recover the SSK for every generation
 * the backend wrapped to us (AAD-bound to our key id), open the trigger + prior
 * history, and return the decrypted prompt plus the {@link SealingState} the turn
 * seals replies/steps with. `streamId` is the E2E root stream — wraps and the
 * owner's message AAD both bind to it. A wrap or history row we can't open is
 * skipped (a generation predating our invite), never fatal; a missing reply or
 * prompt key is fatal (the turn can't be served).
 */
export async function openSealedTurnContext(params: {
  sealed: SealedTurnContext
  identity: BotIdentityKey
  streamId: string
}): Promise<OpenedSealedTurn> {
  const { sealed, identity, streamId } = params
  const sskByGeneration = new Map<number, Uint8Array>()
  for (const wrap of sealed.wraps) {
    try {
      sskByGeneration.set(
        wrap.keyGeneration,
        await unwrapStreamKey({
          enc: base64ToBytes(wrap.wrapEnc),
          ct: base64ToBytes(wrap.wrapCt),
          recipientPrivateKey: identity.privateKey,
          aad: buildWrapAad({ streamId, keyGeneration: wrap.keyGeneration, recipientKeyId: identity.publicKeyId }),
        })
      )
    } catch {
      // A wrap for a generation we weren't invited to — skip it, open what we can.
    }
  }

  const promptSsk = sskByGeneration.get(sealed.prompt.envelope.keyGeneration)
  if (!promptSsk) throw new Error("Sealed claim: no SSK wrap for the prompt's key generation")
  const promptRaw = await openMessageAsString({
    key: promptSsk,
    envelope: sealed.prompt.envelope,
    ciphertext: base64ToBytes(sealed.prompt.ciphertext),
  })
  const promptMarkdown = parseSealedPayload(promptRaw).contentMarkdown

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
      history.push({
        role: item.role,
        sequence: item.sequence,
        contentMarkdown: parseSealedPayload(raw).contentMarkdown,
      })
    } catch {
      continue
    }
  }

  return {
    promptMarkdown,
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
