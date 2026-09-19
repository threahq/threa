/**
 * Read and write an end-to-end-encrypted stream over Threa's public API.
 *
 * The sealed-turn path in `./sealed` covers a bot answering an invocation: the
 * backend hands it ciphertext and SSK wraps on the claim. Everything else — a
 * CLI reading its owner's scratchpad, a bot posting into a sealed stream it was
 * granted but was not invoked in — has to fetch the wraps itself, unwrap the
 * stream key, and open or seal each body. That is this client: the crypto is
 * the same module, but the keys come from the caller's own keyring and the
 * transport is the public HTTP API.
 *
 * Threads inherit their root scratchpad's key and carry no wraps of their own,
 * so every id is resolved to its root before any key work — pass a thread id
 * and it still reads and seals correctly.
 */

import { ulid } from "ulid"
import {
  base64ToBytes,
  buildMessageAad,
  buildWrapAad,
  bytesToBase64,
  importRecipientPrivateKey,
  openMessageAsString,
  parseSealedPayload,
  sealMessage,
  serializeSealedPayload,
  unwrapStreamKey,
  type AttachmentRef,
  type StreamEnvelope,
  type WebCryptoKey,
} from "./crypto"
import type { E2eKeyring } from "./keyring"

/** One key this client can open a wrap with. */
export interface SealedKeyIdentity {
  /** The id wraps are addressed to — a BIK's `publicKeyId`, or a user's UIK key id. */
  keyId: string
  privateKey: WebCryptoKey
}

/**
 * Where the client's private keys come from. A bot passes its runtime keyring;
 * an interactive client passes whatever it unlocked. Called per stream because
 * the per-stream key policy mints one key per sealed stream.
 */
export interface SealedKeySource {
  keysForStream(streamId: string): Promise<SealedKeyIdentity[]>
}

/** Bridge a runtime's {@link E2eKeyring} into a {@link SealedKeySource}. */
export function keyringKeySource(keyring: E2eKeyring): SealedKeySource {
  const imported = new Map<string, Promise<WebCryptoKey>>()
  return {
    async keysForStream(streamId: string): Promise<SealedKeyIdentity[]> {
      await keyring.ensureForStream(streamId)
      const held = keyring.forStream(streamId)
      if (!held) return []
      let privateKey = imported.get(held.keyId)
      if (!privateKey) {
        privateKey = importRecipientPrivateKey(base64ToBytes(held.privateKey))
        imported.set(held.keyId, privateKey)
      }
      return [{ keyId: held.keyId, privateKey: await privateKey }]
    },
  }
}

/**
 * One message from a sealed stream. `contentMarkdown` is the opened body;
 * it is `null` exactly when this client could not open the row, and
 * `unreadableReason` then says why — a row sealed under the pre-stream-key
 * scheme, or a generation no key here is wrapped to. Neither is fatal for the
 * rest of the page, so the row is reported rather than thrown.
 */
export interface SealedStreamMessage {
  id: string
  sequence: string
  authorId: string
  authorType: string
  authorDisplayName?: string
  createdAt: string
  contentMarkdown: string | null
  attachmentRefs: AttachmentRef[]
  unreadableReason?: string
}

export interface SealedStreamPage {
  messages: SealedStreamMessage[]
  hasMore: boolean
}

export interface SealedStreamClientOptions {
  /** Workspace API origin, e.g. `https://eu.threa.io`. */
  baseUrl: string
  apiKey: string
  workspaceId: string
  keys: SealedKeySource
  /**
   * The actor id bound into outgoing message AAD. Resolved from
   * `GET /me` when omitted, which is what a caller holding only a key knows.
   */
  senderId?: string
  fetch?: typeof globalThis.fetch
}

interface WireMessage {
  id: string
  sequence: string
  authorId: string
  authorType: string
  authorDisplayName?: string
  createdAt: string
  sealed?: { ciphertext: string; envelope: StreamEnvelope }
}

interface WireWraps {
  currentKeyGeneration: number
  wraps: { keyGeneration: number; recipientKeyId: string; wrapEnc: string; wrapCt: string }[]
}

/** A non-2xx from the API, carrying the `code` the wire named. */
export class SealedStreamApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(message: string, status: number, code: string) {
    super(message)
    this.name = "SealedStreamApiError"
    this.status = status
    this.code = code
  }
}

export class SealedStreamClient {
  private readonly opts: SealedStreamClientOptions
  private readonly doFetch: typeof globalThis.fetch
  private readonly roots = new Map<string, Promise<string>>()
  private readonly ssks = new Map<string, Uint8Array>()
  private readonly generations = new Map<string, number>()
  private sender?: Promise<string>

  constructor(opts: SealedStreamClientOptions) {
    this.opts = opts
    this.doFetch = opts.fetch ?? globalThis.fetch
  }

  /**
   * One page of decrypted messages, newest-last. `before`/`after` take the
   * `sequence` of a message already held, exactly as the plaintext list does.
   */
  async readMessages(
    streamId: string,
    opts: { limit?: number; before?: string; after?: string } = {}
  ): Promise<SealedStreamPage> {
    const root = await this.resolveRoot(streamId)
    const query = new URLSearchParams()
    if (opts.limit !== undefined) query.set("limit", String(opts.limit))
    if (opts.before) query.set("before", opts.before)
    if (opts.after) query.set("after", opts.after)
    const suffix = query.size > 0 ? `?${query.toString()}` : ""
    const page = await this.request<{ data: WireMessage[]; hasMore: boolean }>(
      "GET",
      `/streams/${streamId}/messages${suffix}`
    )
    const messages: SealedStreamMessage[] = []
    for (const wire of page.data) {
      messages.push(await this.openMessage(root, wire))
    }
    return { messages, hasMore: page.hasMore }
  }

  /**
   * Seal `contentMarkdown` under the stream key and post it. The returned
   * `messageId` is the server's row id; `clientMessageId` is the id this client
   * minted, bound into the body's AAD and reusable to retry the send.
   */
  async sendMessage(
    streamId: string,
    contentMarkdown: string,
    opts: { attachmentRefs?: AttachmentRef[] } = {}
  ): Promise<{ messageId: string; clientMessageId: string }> {
    const root = await this.resolveRoot(streamId)
    const keyGeneration = await this.currentGeneration(root)
    const key = await this.streamKey(root, keyGeneration)
    const senderId = await this.resolveSenderId()
    const clientMessageId = `msg_${ulid()}`
    const sealed = await sealMessage({
      key,
      keyGeneration,
      payload: serializeSealedPayload(contentMarkdown, { attachmentRefs: opts.attachmentRefs }),
      aad: buildMessageAad({ streamId: root, messageId: clientMessageId, senderId }),
    })
    const created = await this.request<{ data: { id: string } }>("POST", `/streams/${streamId}/messages`, {
      sealed: { ciphertext: bytesToBase64(sealed.ciphertext), envelope: sealed.envelope },
      clientMessageId,
    })
    return { messageId: created.data.id, clientMessageId }
  }

  private async openMessage(root: string, wire: WireMessage): Promise<SealedStreamMessage> {
    const base = {
      id: wire.id,
      sequence: wire.sequence,
      authorId: wire.authorId,
      authorType: wire.authorType,
      ...(wire.authorDisplayName ? { authorDisplayName: wire.authorDisplayName } : {}),
      createdAt: wire.createdAt,
      attachmentRefs: [] as AttachmentRef[],
    }
    if (!wire.sealed) {
      return { ...base, contentMarkdown: null, unreadableReason: "Message carries no stream-key envelope" }
    }
    let key: Uint8Array
    try {
      key = await this.streamKey(root, wire.sealed.envelope.keyGeneration)
    } catch (error) {
      return {
        ...base,
        contentMarkdown: null,
        unreadableReason: String(error instanceof Error ? error.message : error),
      }
    }
    const raw = await openMessageAsString({
      key,
      ciphertext: base64ToBytes(wire.sealed.ciphertext),
      envelope: wire.sealed.envelope,
    })
    const payload = parseSealedPayload(raw)
    return { ...base, contentMarkdown: payload.contentMarkdown, attachmentRefs: payload.attachmentRefs ?? [] }
  }

  /**
   * The stream key for one generation. Wraps are fetched once per stream and
   * every generation they cover is unwrapped in that pass, so a page spanning a
   * rotation costs one round trip.
   */
  private async streamKey(root: string, keyGeneration: number): Promise<Uint8Array> {
    const cached = this.ssks.get(`${root}:${keyGeneration}`)
    if (cached) return cached
    await this.loadWraps(root)
    const key = this.ssks.get(`${root}:${keyGeneration}`)
    if (!key) {
      throw new Error(`No key wrap for generation ${keyGeneration} of ${root} is addressed to a key this client holds`)
    }
    return key
  }

  private async currentGeneration(root: string): Promise<number> {
    const known = this.generations.get(root)
    if (known !== undefined) return known
    await this.loadWraps(root)
    return this.generations.get(root) ?? 0
  }

  private async loadWraps(root: string): Promise<void> {
    const identities = await this.opts.keys.keysForStream(root)
    if (identities.length === 0) {
      throw new Error(`No end-to-end key available for ${root}`)
    }
    const wraps = await this.request<{ data: WireWraps }>("GET", `/streams/${root}/e2e/key-wraps`)
    this.generations.set(root, wraps.data.currentKeyGeneration)
    for (const wrap of wraps.data.wraps) {
      const identity = identities.find((candidate) => candidate.keyId === wrap.recipientKeyId)
      if (!identity) continue
      if (this.ssks.has(`${root}:${wrap.keyGeneration}`)) continue
      const key = await unwrapStreamKey({
        enc: base64ToBytes(wrap.wrapEnc),
        ct: base64ToBytes(wrap.wrapCt),
        recipientPrivateKey: identity.privateKey,
        aad: buildWrapAad({
          streamId: root,
          keyGeneration: wrap.keyGeneration,
          recipientKeyId: wrap.recipientKeyId,
        }),
      })
      this.ssks.set(`${root}:${wrap.keyGeneration}`, key)
    }
  }

  /** A thread's key lives on its root; a root resolves to itself. */
  private async resolveRoot(streamId: string): Promise<string> {
    let pending = this.roots.get(streamId)
    if (!pending) {
      pending = this.request<{ data: { id: string; rootStreamId?: string } }>("GET", `/streams/${streamId}`).then(
        (stream) => stream.data.rootStreamId ?? stream.data.id
      )
      this.roots.set(streamId, pending)
    }
    return pending
  }

  private async resolveSenderId(): Promise<string> {
    if (this.opts.senderId) return this.opts.senderId
    if (!this.sender) {
      this.sender = this.request<{ data: { kind: string; userId?: string; botId?: string } }>("GET", "/me").then(
        (me) => {
          const id = me.data.kind === "bot" ? me.data.botId : me.data.userId
          if (!id) throw new Error("GET /me named no principal id")
          return id
        }
      )
    }
    return this.sender
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.opts.baseUrl.replace(/\/$/, "")}/api/v1/workspaces/${this.opts.workspaceId}${path}`
    const response = await this.doFetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.opts.apiKey}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const text = await response.text()
    const parsed = text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {}
    if (!response.ok) {
      throw new SealedStreamApiError(
        typeof parsed.message === "string" ? parsed.message : `${method} ${path} failed`,
        response.status,
        typeof parsed.code === "string" ? parsed.code : "UNKNOWN"
      )
    }
    return parsed as T
  }
}
