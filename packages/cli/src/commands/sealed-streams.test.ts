/**
 * `threa streams read` and `threa messages send` against an end-to-end-encrypted
 * stream, driven by the key `threa e2e unlock` filed on this machine.
 *
 * The fixtures seal and wrap with the same modules the product does, so a read
 * here proves the CLI opens what the workspace actually wrote, and the captured
 * POST body proves the plaintext never left the process.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { Aes256Gcm, CipherSuite, HkdfSha256 } from "@hpke/core"
import { DhkemX25519HkdfSha256 } from "@hpke/dhkem-x25519"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  buildMessageAad,
  buildWrapAad,
  bytesToBase64,
  generateStreamKey,
  openMessageAsString,
  parseSealedPayload,
  sealMessage,
  serializeSealedPayload,
  base64ToBytes,
  type StreamEnvelope,
} from "../../../../extensions/bot-runtime-client/src/crypto"
import { e2eUserKeyAccount } from "../../../../extensions/bot-runtime-client/src/keyring"
import { DEFAULT_KDF_PARAMS, deriveKEK } from "../../../../apps/frontend/src/lib/crypto/passphrase"
import { generateUIK, wrapPrivate } from "../../../../apps/frontend/src/lib/crypto/keys"
import { run } from "../cli"
import { jsonResponse, TEST_CONFIG } from "../test-support"

// Bun's WebCrypto throws on X25519 encap, so the wrap side runs on the noble
// KEM — the same RFC 9180 DHKEM(X25519), wire-interoperable.
const nobleSuite = new CipherSuite({
  kem: new DhkemX25519HkdfSha256(),
  kdf: new HkdfSha256(),
  aead: new Aes256Gcm(),
})

const PASSPHRASE = "correct horse battery staple"
const KEY_ID = "uik_01HZZ"
const ACCOUNT = e2eUserKeyAccount("ws_1", "usr_1")
const STREAM = "stream_01SEALED"
const GENERATION = 4
// 64 MiB Argon2id is roughly a quarter second per derivation.
const TIMEOUT_MS = 20_000

const fetchSpy = spyOn(globalThis, "fetch")
const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "threa-cli-sealed-"))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  fetchSpy.mockReset()
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true })
})

interface Captured {
  path: string
  method: string
  body: unknown
}

/** Route by path so a test states the server's answers, not a call order. */
function serve(routes: Record<string, (captured: Captured) => Response>): Captured[] {
  const seen: Captured[] = []
  fetchSpy.mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname.replace("/api/v1/workspaces/ws_1", "")
    const captured: Captured = {
      path,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    }
    seen.push(captured)
    const route = routes[path]
    if (!route) throw new Error(`unexpected request to ${path}`)
    return route(captured)
  }) as unknown as typeof fetch)
  return seen
}

/** A user identity key the way the web app mints it, plus its wrapped bundle. */
async function browserKey() {
  const uik = await generateUIK()
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const kek = await deriveKEK(PASSPHRASE, salt, DEFAULT_KDF_PARAMS)
  return {
    publicKey: uik.publicKey,
    body: {
      keyId: KEY_ID,
      publicKey: bytesToBase64(uik.publicKey),
      encryptedPrivateBundle: bytesToBase64(await wrapPrivate(uik.privateKey, kek)),
      kdfSalt: bytesToBase64(salt),
      kdfParams: DEFAULT_KDF_PARAMS,
      createdAt: "2026-09-19T00:00:00.000Z",
    },
  }
}

/** The stream key, wrapped to this user the way a grant writes it. */
async function wrapToUser(publicKey: Uint8Array, streamKey: Uint8Array, keyGeneration: number) {
  const aad = buildWrapAad({ streamId: STREAM, keyGeneration, recipientKeyId: KEY_ID })
  const recipient = await nobleSuite.kem.deserializePublicKey(
    publicKey.buffer.slice(publicKey.byteOffset, publicKey.byteOffset + publicKey.byteLength)
  )
  const sealed = await nobleSuite.seal({ recipientPublicKey: recipient }, streamKey, aad)
  return {
    keyGeneration,
    recipientKeyId: KEY_ID,
    wrapEnc: bytesToBase64(new Uint8Array(sealed.enc)),
    wrapCt: bytesToBase64(new Uint8Array(sealed.ct)),
  }
}

async function sealedRow(
  streamKey: Uint8Array,
  contentMarkdown: string,
  keyGeneration = GENERATION
): Promise<Record<string, unknown>> {
  const sealed = await sealMessage({
    key: streamKey,
    keyGeneration,
    payload: serializeSealedPayload(contentMarkdown),
    aad: buildMessageAad({ streamId: STREAM, messageId: "msg_1", senderId: "usr_1" }),
  })
  return {
    id: "msg_1",
    sequence: "7",
    authorId: "usr_1",
    authorType: "user",
    createdAt: "2026-09-19T09:00:00.000Z",
    // What the server stores in place of a readable body: a zero-width space.
    content: "​",
    sealed: { ciphertext: bytesToBase64(sealed.ciphertext), envelope: sealed.envelope },
  }
}

const ME_USER = () => jsonResponse(200, { data: { kind: "user", userId: "usr_1" } })
const USERS = () => jsonResponse(200, { data: [{ id: "usr_1", name: "Kris", slug: "kris" }], hasMore: false })
const SEALED_STREAM = () =>
  jsonResponse(200, { data: { id: STREAM, type: "scratchpad", rootStreamId: null, e2eEnabled: true } })

async function unlockInto(dir: string, body: unknown): Promise<void> {
  serve({ "/me": ME_USER, "/me/e2e-key": () => jsonResponse(200, { data: body }) })
  const result = await run(["e2e", "unlock", "--key-store", "file", "--key-dir", dir], {
    config: TEST_CONFIG,
    readStdin: () => Promise.resolve(PASSPHRASE),
  })
  // A silent failure here leaves no key on disk, and every assertion below
  // would then be measuring a locked CLI rather than the sealed path.
  if (result.exitCode !== 0) throw new Error(`unlock failed (${result.exitCode}): ${result.stderr}`)
}

describe("threa streams read on a sealed stream", () => {
  test(
    "opens each sealed body with the key this machine holds",
    async () => {
      const dir = tempDir()
      const key = await browserKey()
      await unlockInto(dir, key.body)

      const streamKey = generateStreamKey()
      const wrap = await wrapToUser(key.publicKey, streamKey, GENERATION)
      const row = await sealedRow(streamKey, "the plan is **sealed**")
      serve({
        "/me": ME_USER,
        "/users": USERS,
        [`/streams/${STREAM}`]: SEALED_STREAM,
        [`/streams/${STREAM}/e2e/key-wraps`]: () =>
          jsonResponse(200, { data: { currentKeyGeneration: GENERATION, ownerUserId: "usr_1", wraps: [wrap] } }),
        [`/streams/${STREAM}/messages`]: () => jsonResponse(200, { data: [row], hasMore: false }),
      })

      const result = await run(["streams", "read", STREAM, "--key-store", "file", "--key-dir", dir, "--json"], {
        config: TEST_CONFIG,
      })

      expect(result.exitCode).toBe(0)
      const payload = JSON.parse(result.stdout) as { messages: { data: Record<string, unknown>[] } }
      expect(payload.messages.data[0]).toMatchObject({
        id: "msg_1",
        content: "the plan is **sealed**",
        author: { id: "usr_1", name: "Kris" },
      })
      expect(payload.messages.data[0]).not.toHaveProperty("sealed")
    },
    TIMEOUT_MS
  )

  test(
    "reports a generation no held key opens, and keeps the rest of the page",
    async () => {
      const dir = tempDir()
      const key = await browserKey()
      await unlockInto(dir, key.body)

      const readable = generateStreamKey()
      const revoked = generateStreamKey()
      const wrap = await wrapToUser(key.publicKey, readable, GENERATION)
      const rows = [
        await sealedRow(readable, "you can read this"),
        { ...(await sealedRow(revoked, "you cannot", GENERATION + 1)), id: "msg_2", sequence: "8" },
      ]
      serve({
        "/me": ME_USER,
        "/users": USERS,
        [`/streams/${STREAM}`]: SEALED_STREAM,
        [`/streams/${STREAM}/e2e/key-wraps`]: () =>
          jsonResponse(200, { data: { currentKeyGeneration: GENERATION, ownerUserId: "usr_1", wraps: [wrap] } }),
        [`/streams/${STREAM}/messages`]: () => jsonResponse(200, { data: rows, hasMore: false }),
      })

      const result = await run(["streams", "read", STREAM, "--key-store", "file", "--key-dir", dir], {
        config: TEST_CONFIG,
      })

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain("you can read this")
      expect(result.stdout).toContain("<unreadable:")
      expect(result.stdout).not.toContain("you cannot")
    },
    TIMEOUT_MS
  )

  test("says no key is unlocked here rather than printing the placeholder", async () => {
    const dir = tempDir()
    serve({
      "/me": ME_USER,
      "/users": USERS,
      [`/streams/${STREAM}`]: SEALED_STREAM,
      [`/streams/${STREAM}/messages`]: () =>
        jsonResponse(200, {
          data: [
            {
              id: "msg_1",
              sequence: "7",
              authorId: "usr_1",
              authorType: "user",
              createdAt: "2026-09-19T09:00:00.000Z",
              content: "​",
              sealed: { ciphertext: "AAAA", envelope: { v: 2, keyGeneration: 1, iv: "aXY=", aad: "YWFk" } },
            },
          ],
          hasMore: false,
        }),
    })

    const result = await run(["streams", "read", STREAM, "--key-store", "file", "--key-dir", dir], {
      config: TEST_CONFIG,
    })

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain("threa e2e unlock")
  })
})

describe("threa messages send into a sealed stream", () => {
  test(
    "seals the body here and posts only ciphertext",
    async () => {
      const dir = tempDir()
      const key = await browserKey()
      await unlockInto(dir, key.body)

      const streamKey = generateStreamKey()
      const wrap = await wrapToUser(key.publicKey, streamKey, GENERATION)
      const seen = serve({
        "/me": ME_USER,
        [`/streams/${STREAM}`]: SEALED_STREAM,
        [`/streams/${STREAM}/e2e/key-wraps`]: () =>
          jsonResponse(200, { data: { currentKeyGeneration: GENERATION, ownerUserId: "usr_1", wraps: [wrap] } }),
        [`/streams/${STREAM}/messages`]: () => jsonResponse(201, { data: { id: "msg_new" } }),
      })

      const result = await run(
        ["messages", "send", STREAM, "ship it", "--key-store", "file", "--key-dir", dir, "--json"],
        { config: TEST_CONFIG }
      )

      expect(result.exitCode).toBe(0)
      expect(JSON.parse(result.stdout)).toMatchObject({ data: { id: "msg_new" }, sealed: true })

      const post = seen.find((call) => call.method === "POST")!
      const body = post.body as { content?: string; sealed: { ciphertext: string; envelope: StreamEnvelope } }
      expect(body.content).toBeUndefined()
      expect(JSON.stringify(body)).not.toContain("ship it")
      const opened = await openMessageAsString({
        key: streamKey,
        ciphertext: base64ToBytes(body.sealed.ciphertext),
        envelope: body.sealed.envelope,
      })
      expect(parseSealedPayload(opened).contentMarkdown).toBe("ship it")
    },
    TIMEOUT_MS
  )

  test(
    "refuses metadata and conversations there instead of dropping them in the clear",
    async () => {
      const dir = tempDir()
      const key = await browserKey()
      await unlockInto(dir, key.body)

      const seen = serve({ "/me": ME_USER, [`/streams/${STREAM}`]: SEALED_STREAM })

      const withMetadata = await run(
        ["messages", "send", STREAM, "hi", "--metadata", "k=v", "--key-store", "file", "--key-dir", dir],
        { config: TEST_CONFIG }
      )
      const withConversation = await run(
        ["messages", "send", STREAM, "hi", "--new-conversation", "--key-store", "file", "--key-dir", dir],
        { config: TEST_CONFIG }
      )

      expect(withMetadata.exitCode).not.toBe(0)
      expect(withMetadata.stderr).toContain("metadata")
      expect(withConversation.exitCode).not.toBe(0)
      expect(withConversation.stderr).toContain("Conversations")
      expect(seen.some((call) => call.method === "POST")).toBe(false)
    },
    TIMEOUT_MS
  )

  test("sends a plaintext stream in the clear, untouched by the key store", async () => {
    const dir = tempDir()
    const seen = serve({
      [`/streams/${STREAM}`]: () => jsonResponse(200, { data: { id: STREAM, type: "scratchpad" } }),
      [`/streams/${STREAM}/messages`]: () => jsonResponse(201, { data: { id: "msg_new" } }),
    })

    const result = await run(
      ["messages", "send", STREAM, "in the clear", "--key-store", "file", "--key-dir", dir, "--json"],
      { config: TEST_CONFIG }
    )

    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ data: { id: "msg_new" }, sealed: false })
    expect((seen.find((call) => call.method === "POST")!.body as { content: string }).content).toBe("in the clear")
  })
})
