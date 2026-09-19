import { describe, expect, test } from "bun:test"
import { Aes256Gcm, CipherSuite, HkdfSha256 } from "@hpke/core"
import { DhkemX25519HkdfSha256 } from "@hpke/dhkem-x25519"
import { buildWrapAad, generateStreamKey, unwrapStreamKey } from "./crypto"
import { DEFAULT_KDF_PARAMS, deriveKEK, unlockUserKey, unwrapPrivate } from "./user-key"
// The browser is the writer of this format, so it is the only honest source for
// a fixture. Imported by relative path: `@threahq/crypto`, which `keys.ts`
// pulls in, resolves from the frontend workspace and not from this standalone
// extension. This file is a dev/CI drift guard and never ships.
import {
  DEFAULT_KDF_PARAMS as browserKdfParams,
  deriveKEK as browserDeriveKEK,
} from "../../../apps/frontend/src/lib/crypto/passphrase"
import { generateUIK, wrapPrivate } from "../../../apps/frontend/src/lib/crypto/keys"

// Bun's WebCrypto throws on X25519 encap, so wrapping runs on the noble KEM.
// Same RFC 9180 DHKEM(X25519) as the native suite, wire-interoperable.
const nobleSuite = new CipherSuite({
  kem: new DhkemX25519HkdfSha256(),
  kdf: new HkdfSha256(),
  aead: new Aes256Gcm(),
})

const PASSPHRASE = "correct horse battery staple"
// 64 MiB Argon2id takes roughly a quarter second per derivation, and several
// cases here derive twice.
const TIMEOUT_MS = 20_000

function freshSalt(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(16))
}

async function sealBrowserBundle(salt: Uint8Array) {
  const uik = await generateUIK()
  const kek = await browserDeriveKEK(PASSPHRASE, salt, browserKdfParams)
  return { uik, bundle: await wrapPrivate(uik.privateKey, kek) }
}

describe("user key unlock stays byte-compatible with the browser", () => {
  test("KDF defaults match the browser's", () => {
    expect(DEFAULT_KDF_PARAMS).toEqual(browserKdfParams)
  })

  test(
    "a key the browser wrapped opens a stream key wrapped to it",
    async () => {
      const salt = freshSalt()
      const { uik, bundle } = await sealBrowserBundle(salt)

      // Someone wraps a stream key to this user's public half, as the owner's
      // client does when granting access.
      const ssk = generateStreamKey()
      const aad = buildWrapAad({ streamId: "stream_01HZX", keyGeneration: 3, recipientKeyId: "uik_01HZZ" })
      const recipient = await nobleSuite.kem.deserializePublicKey(
        uik.publicKey.buffer.slice(uik.publicKey.byteOffset, uik.publicKey.byteOffset + uik.publicKey.byteLength)
      )
      const sealed = await nobleSuite.seal({ recipientPublicKey: recipient }, ssk, aad)

      // The CLI holds the passphrase and the server's bundle, nothing else.
      const privateKey = await unlockUserKey({
        passphrase: PASSPHRASE,
        encryptedPrivateBundle: bundle,
        kdfSalt: salt,
        kdfParams: browserKdfParams,
      })
      const recovered = await unwrapStreamKey({
        enc: new Uint8Array(sealed.enc),
        ct: new Uint8Array(sealed.ct),
        recipientPrivateKey: privateKey,
        aad,
      })

      expect(Array.from(recovered)).toEqual(Array.from(ssk))
    },
    TIMEOUT_MS
  )

  test(
    "the wrong passphrase is rejected rather than yielding a broken key",
    async () => {
      const salt = freshSalt()
      const { bundle } = await sealBrowserBundle(salt)

      await expect(
        unlockUserKey({
          passphrase: "not the passphrase",
          encryptedPrivateBundle: bundle,
          kdfSalt: salt,
          kdfParams: browserKdfParams,
        })
      ).rejects.toThrow()
    },
    TIMEOUT_MS
  )

  test(
    "a tampered bundle fails the GCM tag",
    async () => {
      const salt = freshSalt()
      const { bundle } = await sealBrowserBundle(salt)
      const kek = await deriveKEK(PASSPHRASE, salt, browserKdfParams)

      const tampered = new Uint8Array(bundle)
      const last = tampered.length - 1
      tampered[last] = tampered[last]! ^ 0xff
      await expect(unwrapPrivate(tampered, kek)).rejects.toThrow()
    },
    TIMEOUT_MS
  )
})

describe("user key unlock refuses what it cannot honour", () => {
  test("an unsupported KDF algorithm throws", async () => {
    await expect(
      deriveKEK(PASSPHRASE, freshSalt(), { ...DEFAULT_KDF_PARAMS, algorithm: "scrypt" as "argon2id" })
    ).rejects.toThrow(/Unsupported KDF algorithm/)
  })

  test("an unsupported Argon2 version throws instead of deriving a wrong key", async () => {
    await expect(deriveKEK(PASSPHRASE, freshSalt(), { ...DEFAULT_KDF_PARAMS, version: 16 })).rejects.toThrow(
      /Unsupported Argon2 version/
    )
  })

  test("a bundle from a future format version throws", async () => {
    const kek = await deriveKEK(PASSPHRASE, freshSalt(), DEFAULT_KDF_PARAMS)
    const bundle = new Uint8Array(1 + 12 + 16)
    bundle[0] = 2
    await expect(unwrapPrivate(bundle, kek)).rejects.toThrow(/Unsupported private bundle version/)
  })

  test("a truncated bundle throws", async () => {
    const kek = await deriveKEK(PASSPHRASE, freshSalt(), DEFAULT_KDF_PARAMS)
    await expect(unwrapPrivate(new Uint8Array(8), kek)).rejects.toThrow(/too short/)
  })
})
