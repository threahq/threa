/**
 * `threa e2e` end to end: a bundle the browser actually wrapped, opened here
 * with the passphrase, and the recovered key used to open a stream key someone
 * wrapped to its public half.
 *
 * The browser modules are imported by relative path so the fixture comes from
 * the code that writes this format, not a second implementation of it.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { Aes256Gcm, CipherSuite, HkdfSha256 } from "@hpke/core"
import { DhkemX25519HkdfSha256 } from "@hpke/dhkem-x25519"
import { mkdtempSync, readFileSync, existsSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  buildWrapAad,
  bytesToBase64,
  generateStreamKey,
  importRecipientPrivateKey,
  base64ToBytes,
  unwrapStreamKey,
} from "../../../../extensions/bot-runtime-client/src/crypto"
import { e2eUserKeyAccount } from "../../../../extensions/bot-runtime-client/src/keyring"
import { DEFAULT_KDF_PARAMS, deriveKEK } from "../../../../apps/frontend/src/lib/crypto/passphrase"
import { generateUIK, wrapPrivate } from "../../../../apps/frontend/src/lib/crypto/keys"
import { run } from "../cli"
import { jsonResponse, TEST_CONFIG } from "../test-support"

// Bun's WebCrypto throws on X25519 encap, so the grant side runs on the noble
// KEM — the same RFC 9180 DHKEM(X25519), wire-interoperable.
const nobleSuite = new CipherSuite({
  kem: new DhkemX25519HkdfSha256(),
  kdf: new HkdfSha256(),
  aead: new Aes256Gcm(),
})

const PASSPHRASE = "correct horse battery staple"
const KEY_ID = "uik_01HZZ"
const ACCOUNT = e2eUserKeyAccount("ws_1", "usr_1")
// 64 MiB Argon2id is roughly a quarter second per derivation.
const TIMEOUT_MS = 20_000

const fetchSpy = spyOn(globalThis, "fetch")
const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "threa-cli-e2e-"))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  fetchSpy.mockReset()
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true })
})

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

/** Route by path so a test states the server's answers, not a call order. */
function serve(routes: Record<string, () => Response>): void {
  fetchSpy.mockImplementation((async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname.replace("/api/v1/workspaces/ws_1", "")
    const route = routes[path]
    if (!route) throw new Error(`unexpected request to ${path}`)
    return route()
  }) as unknown as typeof fetch)
}

const ME_USER = () => jsonResponse(200, { data: { kind: "user", userId: "usr_1" } })

function heldRecord(dir: string): { keyId: string; publicKey: string; privateKey: string } {
  return JSON.parse(readFileSync(join(dir, `${ACCOUNT}.json`), "utf8")) as {
    keyId: string
    publicKey: string
    privateKey: string
  }
}

describe("threa e2e unlock", () => {
  test(
    "the key a passphrase opens is the one a stream key was wrapped to",
    async () => {
      const dir = tempDir()
      const { publicKey, body } = await browserKey()
      serve({ "/me": ME_USER, "/me/e2e-key": () => jsonResponse(200, { data: body }) })

      const result = await run(["e2e", "unlock", "--key-store", "file", "--key-dir", dir, "--json"], {
        config: TEST_CONFIG,
        readStdin: () => Promise.resolve(`${PASSPHRASE}\n`),
      })

      expect(result.exitCode).toBe(0)
      expect(JSON.parse(result.stdout)).toMatchObject({ keyId: KEY_ID, store: "file", unchanged: false })

      // Someone grants this user a sealed stream, wrapping to the public half.
      const ssk = generateStreamKey()
      const aad = buildWrapAad({ streamId: "stream_01HZX", keyGeneration: 3, recipientKeyId: KEY_ID })
      const recipient = await nobleSuite.kem.deserializePublicKey(
        publicKey.buffer.slice(publicKey.byteOffset, publicKey.byteOffset + publicKey.byteLength)
      )
      const sealed = await nobleSuite.seal({ recipientPublicKey: recipient }, ssk, aad)

      const held = heldRecord(dir)
      const opened = await unwrapStreamKey({
        enc: new Uint8Array(sealed.enc),
        ct: new Uint8Array(sealed.ct),
        recipientPrivateKey: await importRecipientPrivateKey(base64ToBytes(held.privateKey)),
        aad,
      })
      expect(bytesToBase64(opened)).toBe(bytesToBase64(ssk))
      expect(held.keyId).toBe(KEY_ID)
    },
    TIMEOUT_MS
  )

  test(
    "a wrong passphrase fails and leaves nothing on the machine",
    async () => {
      const dir = tempDir()
      const { body } = await browserKey()
      serve({ "/me": ME_USER, "/me/e2e-key": () => jsonResponse(200, { data: body }) })

      const result = await run(["e2e", "unlock", "--key-store", "file", "--key-dir", dir], {
        config: TEST_CONFIG,
        readStdin: () => Promise.resolve("hunter2\n"),
      })

      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain("does not open your encryption key")
      expect(existsSync(join(dir, `${ACCOUNT}.json`))).toBe(false)
    },
    TIMEOUT_MS
  )

  test(
    "unlocking again after a rotation replaces the key this machine holds",
    async () => {
      const dir = tempDir()
      const first = await browserKey()
      serve({ "/me": ME_USER, "/me/e2e-key": () => jsonResponse(200, { data: first.body }) })
      await run(["e2e", "unlock", "--key-store", "file", "--key-dir", dir], {
        config: TEST_CONFIG,
        readStdin: () => Promise.resolve(PASSPHRASE),
      })

      const rotated = await browserKey()
      const rotatedBody = { ...rotated.body, keyId: "uik_02ROT" }
      serve({ "/me": ME_USER, "/me/e2e-key": () => jsonResponse(200, { data: rotatedBody }) })
      const result = await run(["e2e", "unlock", "--key-store", "file", "--key-dir", dir, "--json"], {
        config: TEST_CONFIG,
        readStdin: () => Promise.resolve(PASSPHRASE),
      })

      expect(result.exitCode).toBe(0)
      expect(heldRecord(dir).keyId).toBe("uik_02ROT")
    },
    TIMEOUT_MS
  )

  test(
    "unlocking the same key again leaves the stored record untouched",
    async () => {
      const dir = tempDir()
      const { body } = await browserKey()
      serve({ "/me": ME_USER, "/me/e2e-key": () => jsonResponse(200, { data: body }) })
      await run(["e2e", "unlock", "--key-store", "file", "--key-dir", dir], {
        config: TEST_CONFIG,
        readStdin: () => Promise.resolve(PASSPHRASE),
      })
      const written = statSync(join(dir, `${ACCOUNT}.json`)).mtimeMs

      const result = await run(["e2e", "unlock", "--key-store", "file", "--key-dir", dir, "--json"], {
        config: TEST_CONFIG,
        readStdin: () => Promise.resolve(PASSPHRASE),
      })

      expect(result.exitCode).toBe(0)
      expect(JSON.parse(result.stdout)).toMatchObject({ keyId: KEY_ID, unchanged: true })
      expect(statSync(join(dir, `${ACCOUNT}.json`)).mtimeMs).toBe(written)
    },
    TIMEOUT_MS
  )

  test("a bot key is refused before the encrypted bundle is ever fetched", async () => {
    const dir = tempDir()
    serve({ "/me": () => jsonResponse(200, { data: { kind: "bot", botId: "bot_1" } }) })

    const result = await run(["e2e", "unlock", "--key-store", "file", "--key-dir", dir], {
      config: TEST_CONFIG,
      readStdin: () => Promise.resolve(PASSPHRASE),
    })

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain("belong to a person")
  })

  test("an unknown key store is a usage error before any request", async () => {
    const result = await run(["e2e", "unlock", "--key-store", "gnome-keyring"], {
      config: TEST_CONFIG,
      readStdin: () => Promise.resolve(PASSPHRASE),
    })

    expect(result.exitCode).toBe(2)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe("threa e2e status and lock", () => {
  test(
    "status reports a held key as current, then as stale once the workspace rotates",
    async () => {
      const dir = tempDir()
      const { body } = await browserKey()
      serve({ "/me": ME_USER, "/me/e2e-key": () => jsonResponse(200, { data: body }) })
      await run(["e2e", "unlock", "--key-store", "file", "--key-dir", dir], {
        config: TEST_CONFIG,
        readStdin: () => Promise.resolve(PASSPHRASE),
      })

      const current = await run(["e2e", "status", "--key-store", "file", "--key-dir", dir, "--json"], {
        config: TEST_CONFIG,
      })
      expect(JSON.parse(current.stdout)).toMatchObject({ held: true, keyId: KEY_ID, current: true })

      serve({ "/me": ME_USER, "/me/e2e-key": () => jsonResponse(200, { data: { ...body, keyId: "uik_02ROT" } }) })
      const stale = await run(["e2e", "status", "--key-store", "file", "--key-dir", dir], { config: TEST_CONFIG })
      expect(stale.stdout).toContain("moved to uik_02ROT")
    },
    TIMEOUT_MS
  )

  test("status with no key set up anywhere says so instead of failing", async () => {
    const dir = tempDir()
    serve({
      "/me": ME_USER,
      "/me/e2e-key": () => jsonResponse(404, { error: { code: "E2E_KEY_NOT_FOUND", message: "E2E key not set up" } }),
    })

    const result = await run(["e2e", "status", "--key-store", "file", "--key-dir", dir, "--json"], {
      config: TEST_CONFIG,
    })

    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ held: false, current: false })
  })

  test(
    "lock forgets the key, and locking again is not an error",
    async () => {
      const dir = tempDir()
      const { body } = await browserKey()
      serve({ "/me": ME_USER, "/me/e2e-key": () => jsonResponse(200, { data: body }) })
      await run(["e2e", "unlock", "--key-store", "file", "--key-dir", dir], {
        config: TEST_CONFIG,
        readStdin: () => Promise.resolve(PASSPHRASE),
      })

      const first = await run(["e2e", "lock", "--key-store", "file", "--key-dir", dir, "--json"], {
        config: TEST_CONFIG,
      })
      const second = await run(["e2e", "lock", "--key-store", "file", "--key-dir", dir, "--json"], {
        config: TEST_CONFIG,
      })

      expect(JSON.parse(first.stdout)).toMatchObject({ removed: true })
      expect(JSON.parse(second.stdout)).toMatchObject({ removed: false })
      expect(existsSync(join(dir, `${ACCOUNT}.json`))).toBe(false)
    },
    TIMEOUT_MS
  )
})
