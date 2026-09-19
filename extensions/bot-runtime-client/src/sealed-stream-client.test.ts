import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  base64ToBytes,
  buildMessageAad,
  buildWrapAad,
  bytesToBase64,
  exportPublicKey,
  generateKeyPair,
  generateStreamKey,
  importRecipientPublicKey,
  openMessageAsString,
  parseSealedPayload,
  sealMessage,
  serializeSealedPayload,
  unwrapStreamKey,
  wrapStreamKey,
  type StreamEnvelope,
} from "./crypto"
import { E2eKeyring, FileKeyStore } from "./keyring"
import { mintE2eKeyRecord } from "./sealed"
import { keyringKeySource, SealedStreamClient, type SealedKeySource } from "./sealed-stream-client"

const dirs: string[] = []

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true })
})

const WORKSPACE = "ws_test"
const ROOT = "stream_root"
const THREAD = "stream_thread"
const SENDER = "bot_sender"
const KEY_ID = "bik_test"

interface Wire {
  stream?: { id: string; rootStreamId?: string }
  wraps?: { currentKeyGeneration: number; wraps: unknown[] }
  messages?: { data: unknown[]; hasMore: boolean }
}

interface Recorded {
  method: string
  path: string
  body?: Record<string, unknown>
}

/**
 * The public API as three canned reads plus a recording POST. Every call the
 * client makes lands in `calls`, so a test asserts the wire it produced as well
 * as the plaintext it recovered.
 */
function fakeApi(wire: Wire): { fetch: typeof globalThis.fetch; calls: Recorded[] } {
  const calls: Recorded[] = []
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const path = String(url).replace(`https://api.test/api/v1/workspaces/${WORKSPACE}`, "")
    const method = init?.method ?? "GET"
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined
    calls.push({ method, path, body })
    const json = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } })
    if (method === "POST" && path.endsWith("/messages")) return json({ data: { id: "msg_server" } })
    if (path === "/me") return json({ data: { kind: "bot", botId: SENDER } })
    if (path.endsWith("/e2e/key-wraps")) {
      if (!wire.wraps) return json({ code: "E2E_STREAM_REQUIRED", message: "Stream is not encrypted" }, 400)
      return json({ data: wire.wraps })
    }
    if (path.includes("/messages")) return json(wire.messages ?? { data: [], hasMore: false })
    return json({ data: wire.stream ?? { id: ROOT } })
  }) as typeof globalThis.fetch
  return { fetch: fetchImpl, calls }
}

async function sealedFixture(): Promise<{
  keys: SealedKeySource
  ssk: Uint8Array
  wraps: { currentKeyGeneration: number; wraps: unknown[] }
}> {
  const pair = await generateKeyPair()
  const publicKeyB64 = bytesToBase64(await exportPublicKey(pair.publicKey))
  const ssk = generateStreamKey()
  const wrapped = await wrapStreamKey({
    key: ssk,
    recipientPublicKey: await importRecipientPublicKey(base64ToBytes(publicKeyB64)),
    aad: buildWrapAad({ streamId: ROOT, keyGeneration: 0, recipientKeyId: KEY_ID }),
  })
  return {
    keys: { keysForStream: async () => [{ keyId: KEY_ID, privateKey: pair.privateKey }] },
    ssk,
    wraps: {
      currentKeyGeneration: 0,
      wraps: [
        {
          keyGeneration: 0,
          recipientKeyId: KEY_ID,
          recipientKind: "bot",
          wrapEnc: bytesToBase64(wrapped.enc),
          wrapCt: bytesToBase64(wrapped.ct),
        },
      ],
    },
  }
}

function wireMessage(id: string, sealed?: { ciphertext: string; envelope: StreamEnvelope }) {
  return {
    id,
    sequence: "1",
    authorId: "usr_owner",
    authorType: "user",
    createdAt: "2026-09-19T10:00:00.000Z",
    content: "[Encrypted message]",
    ...(sealed ? { sealed } : {}),
  }
}

describe("SealedStreamClient", () => {
  test("opens the sealed bodies the API lists", async () => {
    const { keys, ssk, wraps } = await sealedFixture()
    const sealed = await sealMessage({
      key: ssk,
      keyGeneration: 0,
      payload: serializeSealedPayload("the secret", {
        attachmentRefs: [
          {
            attachmentId: "att_1",
            key: "a2V5",
            iv: "aXY=",
            filename: "notes.md",
            mimeType: "text/markdown",
            sizeBytes: 12,
          },
        ],
      }),
      aad: buildMessageAad({ streamId: ROOT, messageId: "msg_1", senderId: "usr_owner" }),
    })
    const { fetch, calls } = fakeApi({
      wraps,
      messages: {
        data: [wireMessage("msg_1", { ciphertext: bytesToBase64(sealed.ciphertext), envelope: sealed.envelope })],
        hasMore: false,
      },
    })
    const client = new SealedStreamClient({
      baseUrl: "https://api.test",
      apiKey: "k",
      workspaceId: WORKSPACE,
      keys,
      fetch,
    })

    const page = await client.readMessages(ROOT, { limit: 10 })

    expect(page).toEqual({
      hasMore: false,
      messages: [
        {
          id: "msg_1",
          sequence: "1",
          authorId: "usr_owner",
          authorType: "user",
          createdAt: "2026-09-19T10:00:00.000Z",
          contentMarkdown: "the secret",
          attachmentRefs: [
            {
              attachmentId: "att_1",
              key: "a2V5",
              iv: "aXY=",
              filename: "notes.md",
              mimeType: "text/markdown",
              sizeBytes: 12,
            },
          ],
        },
      ],
    })
    expect(calls.map((call) => call.path)).toEqual([
      `/streams/${ROOT}`,
      `/streams/${ROOT}/messages?limit=10`,
      `/streams/${ROOT}/e2e/key-wraps`,
    ])
  })

  test("reports a row it cannot open without losing the page", async () => {
    const { keys, ssk, wraps } = await sealedFixture()
    const readable = await sealMessage({
      key: ssk,
      keyGeneration: 0,
      payload: serializeSealedPayload("still readable"),
      aad: buildMessageAad({ streamId: ROOT, messageId: "msg_2", senderId: "usr_owner" }),
    })
    const { fetch } = fakeApi({
      wraps,
      messages: {
        data: [
          wireMessage("msg_legacy"),
          wireMessage("msg_rotated", {
            ciphertext: bytesToBase64(readable.ciphertext),
            envelope: { ...readable.envelope, keyGeneration: 7 },
          }),
          wireMessage("msg_tampered", {
            ciphertext: bytesToBase64(readable.ciphertext),
            envelope: {
              ...readable.envelope,
              aad: bytesToBase64(buildMessageAad({ streamId: ROOT, messageId: "msg_other", senderId: "usr_owner" })),
            },
          }),
          wireMessage("msg_2", { ciphertext: bytesToBase64(readable.ciphertext), envelope: readable.envelope }),
        ],
        hasMore: true,
      },
    })
    const client = new SealedStreamClient({
      baseUrl: "https://api.test",
      apiKey: "k",
      workspaceId: WORKSPACE,
      keys,
      fetch,
    })

    const page = await client.readMessages(ROOT)

    expect(page.messages.map((message) => [message.id, message.contentMarkdown, message.unreadableReason])).toEqual([
      ["msg_legacy", null, "Message carries no stream-key envelope"],
      ["msg_rotated", null, `No key wrap for generation 7 of ${ROOT} is addressed to a key this client holds`],
      ["msg_tampered", null, expect.any(String)],
      ["msg_2", "still readable", undefined],
    ])
  })

  test("seals a send under the stream key, bound to the id it posts", async () => {
    const { keys, ssk, wraps } = await sealedFixture()
    const { fetch, calls } = fakeApi({ wraps })
    const client = new SealedStreamClient({
      baseUrl: "https://api.test",
      apiKey: "k",
      workspaceId: WORKSPACE,
      keys,
      fetch,
    })

    const sent = await client.sendMessage(ROOT, "from the bot")

    expect(sent.messageId).toBe("msg_server")
    const posted = calls.find((call) => call.method === "POST")!.body as {
      sealed: { ciphertext: string; envelope: StreamEnvelope }
      clientMessageId: string
    }
    expect(posted.clientMessageId).toBe(sent.clientMessageId)
    const opened = await openMessageAsString({
      key: ssk,
      ciphertext: base64ToBytes(posted.sealed.ciphertext),
      envelope: posted.sealed.envelope,
    })
    expect(parseSealedPayload(opened).contentMarkdown).toBe("from the bot")
    // The AAD binds the body to the stream, the id it was posted under, and the
    // principal `GET /me` named — the same binding the first-party client makes.
    expect(base64ToBytes(posted.sealed.envelope.aad)).toEqual(
      buildMessageAad({ streamId: ROOT, messageId: sent.clientMessageId, senderId: SENDER })
    )
  })

  test("seals under the generation the stream is at now, not the one it opened with", async () => {
    const pair = await generateKeyPair()
    const publicKey = await importRecipientPublicKey(await exportPublicKey(pair.publicKey))
    const wrapFor = async (key: Uint8Array, keyGeneration: number) => {
      const wrapped = await wrapStreamKey({
        key,
        recipientPublicKey: publicKey,
        aad: buildWrapAad({ streamId: ROOT, keyGeneration, recipientKeyId: KEY_ID }),
      })
      return {
        keyGeneration,
        recipientKeyId: KEY_ID,
        recipientKind: "bot",
        wrapEnc: bytesToBase64(wrapped.enc),
        wrapCt: bytesToBase64(wrapped.ct),
      }
    }
    const first = generateStreamKey()
    const rotated = generateStreamKey()
    const wire: Wire = { wraps: { currentKeyGeneration: 0, wraps: [await wrapFor(first, 0)] } }
    const { fetch, calls } = fakeApi(wire)
    const client = new SealedStreamClient({
      baseUrl: "https://api.test",
      apiKey: "k",
      workspaceId: WORKSPACE,
      keys: { keysForStream: async () => [{ keyId: KEY_ID, privateKey: pair.privateKey }] },
      fetch,
    })

    await client.sendMessage(ROOT, "before the roll")
    wire.wraps = { currentKeyGeneration: 1, wraps: [await wrapFor(first, 0), await wrapFor(rotated, 1)] }
    const sent = await client.sendMessage(ROOT, "after the roll")

    const posted = calls.filter((call) => call.method === "POST").at(-1)!.body as {
      sealed: { ciphertext: string; envelope: StreamEnvelope }
    }
    expect(posted.sealed.envelope.keyGeneration).toBe(1)
    const opened = await openMessageAsString({
      key: rotated,
      ciphertext: base64ToBytes(posted.sealed.ciphertext),
      envelope: posted.sealed.envelope,
    })
    expect(parseSealedPayload(opened).contentMarkdown).toBe("after the roll")
    expect(base64ToBytes(posted.sealed.envelope.aad)).toEqual(
      buildMessageAad({ streamId: ROOT, messageId: sent.clientMessageId, senderId: SENDER })
    )
  })

  test("keeps the HTTP status when the error body is not JSON", async () => {
    const { keys } = await sealedFixture()
    const fetch = (async (_url: string | URL, _init?: RequestInit) =>
      new Response("<html>gateway</html>", { status: 502 })) as typeof globalThis.fetch
    const client = new SealedStreamClient({
      baseUrl: "https://api.test",
      apiKey: "k",
      workspaceId: WORKSPACE,
      keys,
      fetch,
    })

    await expect(client.readMessages(ROOT)).rejects.toMatchObject({
      name: "SealedStreamApiError",
      status: 502,
      code: "UNKNOWN",
    })
  })

  test("retries a lookup whose first attempt failed", async () => {
    const { keys, wraps } = await sealedFixture()
    const { fetch: happy } = fakeApi({ wraps })
    let attempts = 0
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      attempts += 1
      if (attempts === 1) return new Response(JSON.stringify({ code: "INTERNAL", message: "boom" }), { status: 500 })
      return happy(url as never, init as never)
    }) as typeof globalThis.fetch
    const client = new SealedStreamClient({
      baseUrl: "https://api.test",
      apiKey: "k",
      workspaceId: WORKSPACE,
      keys,
      fetch: fetchImpl,
    })

    await expect(client.readMessages(ROOT)).rejects.toMatchObject({ status: 500 })

    expect(await client.readMessages(ROOT)).toEqual({ messages: [], hasMore: false })
  })

  test("resolves a thread to its root before touching keys", async () => {
    const { keys, wraps } = await sealedFixture()
    const { fetch, calls } = fakeApi({ stream: { id: THREAD, rootStreamId: ROOT }, wraps })
    const client = new SealedStreamClient({
      baseUrl: "https://api.test",
      apiKey: "k",
      workspaceId: WORKSPACE,
      keys,
      fetch,
    })

    await client.sendMessage(THREAD, "in the thread")

    // Keys come from the root, the message goes to the thread.
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      `GET /streams/${THREAD}`,
      `GET /streams/${ROOT}/e2e/key-wraps`,
      "GET /me",
      `POST /streams/${THREAD}/messages`,
    ])
  })

  test("surfaces the API's error code", async () => {
    const { keys } = await sealedFixture()
    const { fetch } = fakeApi({})
    const client = new SealedStreamClient({
      baseUrl: "https://api.test",
      apiKey: "k",
      workspaceId: WORKSPACE,
      keys,
      fetch,
    })

    const failure = client.sendMessage(ROOT, "nope")

    await expect(failure).rejects.toMatchObject({
      name: "SealedStreamApiError",
      status: 400,
      code: "E2E_STREAM_REQUIRED",
    })
  })

  test("refuses to send when the keyring holds nothing for the stream", async () => {
    const { fetch } = fakeApi({ wraps: { currentKeyGeneration: 0, wraps: [] } })
    const client = new SealedStreamClient({
      baseUrl: "https://api.test",
      apiKey: "k",
      workspaceId: WORKSPACE,
      keys: { keysForStream: async () => [] },
      fetch,
    })

    await expect(client.sendMessage(ROOT, "no key")).rejects.toThrow(`No end-to-end key available for ${ROOT}`)
  })
})

describe("keyringKeySource", () => {
  test("hands the client a runtime keyring's key, usable to unwrap", async () => {
    const dir = mkdtempSync(join(tmpdir(), "threa-sealed-client-"))
    dirs.push(dir)
    const keyring = new E2eKeyring({
      store: new FileKeyStore({ dir }),
      account: "host-test",
      mint: mintE2eKeyRecord,
      log: () => {},
    })
    await keyring.ensure()
    const held = keyring.current[0]!

    const identity = (await keyringKeySource(keyring).keysForStream(ROOT))[0]!

    expect(identity.keyId).toBe(held.keyId)
    // The base64 private half has to come back as a usable key, so prove it by
    // opening a wrap addressed to the public half the keyring advertises.
    const ssk = generateStreamKey()
    const aad = buildWrapAad({ streamId: ROOT, keyGeneration: 0, recipientKeyId: held.keyId })
    const wrapped = await wrapStreamKey({
      key: ssk,
      recipientPublicKey: await importRecipientPublicKey(base64ToBytes(held.publicKey)),
      aad,
    })
    const unwrapped = await unwrapStreamKey({
      enc: wrapped.enc,
      ct: wrapped.ct,
      recipientPrivateKey: identity.privateKey,
      aad,
    })
    expect(unwrapped).toEqual(ssk)
  })
})
