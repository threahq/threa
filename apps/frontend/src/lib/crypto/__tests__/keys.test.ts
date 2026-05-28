import { describe, expect, it } from "vitest"
import { fingerprintPublicKey, generateUIK, toNonExtractable, unwrapPrivate, wrapPrivate } from "../keys"
import { deriveKEK, generateSalt, DEFAULT_KDF_PARAMS } from "../passphrase"
import { encryptPayload, decryptPayloadAsString } from "@threa/crypto"

// Argon2id on the desktop CI runs in ~50ms with the defaults below; tighten
// further if test runtime becomes an issue.
const FAST_PARAMS = { ...DEFAULT_KDF_PARAMS, m: 8 * 1024, t: 1 }

describe("UIK lifecycle", () => {
  it("wraps and unwraps the private key correctly with the same passphrase", async () => {
    const uik = await generateUIK()
    const salt = generateSalt()
    const kek = await deriveKEK("correct-horse-battery-staple", salt, FAST_PARAMS)

    const wrapped = await wrapPrivate(uik.privateKey, kek)
    expect(wrapped.length).toBeGreaterThan(13)
    expect(wrapped[0]).toBe(1) // bundle version

    const kekAgain = await deriveKEK("correct-horse-battery-staple", salt, FAST_PARAMS)
    const unwrapped = await unwrapPrivate(wrapped, kekAgain)

    // Round-trip via an envelope: encrypt with publicKey, decrypt with unwrapped private.
    const { envelope } = await encryptPayload({
      payload: "secret",
      recipients: [{ recipientKeyId: "e2ek_self", publicKey: uik.publicKey }],
    })
    const decoded = await decryptPayloadAsString({
      envelope,
      privateKey: unwrapped,
      recipientKeyId: "e2ek_self",
    })
    expect(decoded).toBe("secret")
  })

  it("fails to unwrap with a wrong passphrase", async () => {
    const uik = await generateUIK()
    const salt = generateSalt()
    const kek = await deriveKEK("right-passphrase", salt, FAST_PARAMS)
    const wrapped = await wrapPrivate(uik.privateKey, kek)

    const wrongKek = await deriveKEK("wrong-passphrase", salt, FAST_PARAMS)
    await expect(unwrapPrivate(wrapped, wrongKek)).rejects.toThrow()
  })

  it("rejects a bundle with an unsupported version byte", async () => {
    const uik = await generateUIK()
    const salt = generateSalt()
    const kek = await deriveKEK("p", salt, FAST_PARAMS)
    const wrapped = await wrapPrivate(uik.privateKey, kek)
    const tampered = new Uint8Array(wrapped)
    tampered[0] = 99
    await expect(unwrapPrivate(tampered, kek)).rejects.toThrow(/Unsupported private bundle version/)
  })

  it("unwraps a non-extractable key by default that still decrypts but cannot be exported", async () => {
    const uik = await generateUIK()
    const salt = generateSalt()
    const kek = await deriveKEK("pp", salt, FAST_PARAMS)
    const wrapped = await wrapPrivate(uik.privateKey, kek)

    const priv = await unwrapPrivate(wrapped, await deriveKEK("pp", salt, FAST_PARAMS))
    expect(priv.extractable).toBe(false)
    await expect(crypto.subtle.exportKey("pkcs8", priv)).rejects.toThrow()

    const { envelope } = await encryptPayload({
      payload: "secret",
      recipients: [{ recipientKeyId: "e2ek_self", publicKey: uik.publicKey }],
    })
    expect(await decryptPayloadAsString({ envelope, privateKey: priv, recipientKeyId: "e2ek_self" })).toBe("secret")
  })

  it("unwraps an extractable key when asked (the rotation path needs the raw bytes)", async () => {
    const uik = await generateUIK()
    const salt = generateSalt()
    const kek = await deriveKEK("pp", salt, FAST_PARAMS)
    const wrapped = await wrapPrivate(uik.privateKey, kek)

    const priv = await unwrapPrivate(wrapped, await deriveKEK("pp", salt, FAST_PARAMS), { extractable: true })
    expect(priv.extractable).toBe(true)
    // Re-wrapping (what rotation does) requires the bytes to be exportable.
    const rewrapped = await wrapPrivate(priv, kek)
    expect(rewrapped[0]).toBe(1)
  })

  it("toNonExtractable hardens an extractable key while preserving decryption", async () => {
    const uik = await generateUIK()
    expect(uik.privateKey.extractable).toBe(true)

    const hardened = await toNonExtractable(uik.privateKey)
    expect(hardened.extractable).toBe(false)
    await expect(crypto.subtle.exportKey("pkcs8", hardened)).rejects.toThrow()

    const { envelope } = await encryptPayload({
      payload: "still-decodes",
      recipients: [{ recipientKeyId: "e2ek_self", publicKey: uik.publicKey }],
    })
    expect(await decryptPayloadAsString({ envelope, privateKey: hardened, recipientKeyId: "e2ek_self" })).toBe(
      "still-decodes"
    )
  })
})

describe("fingerprintPublicKey", () => {
  it("is deterministic for the same bytes", async () => {
    const pk = new Uint8Array(32).map((_, i) => i)
    const a = await fingerprintPublicKey(pk)
    const b = await fingerprintPublicKey(pk)
    expect(a).toBe(b)
  })

  it("differs when any byte differs", async () => {
    const a = new Uint8Array(32).map((_, i) => i)
    const b = new Uint8Array(32).map((_, i) => i)
    b[0] = (b[0]! + 1) & 0xff
    expect(await fingerprintPublicKey(a)).not.toBe(await fingerprintPublicKey(b))
  })

  it("renders four 4-char hex groups separated by spaces", async () => {
    const pk = new Uint8Array(32)
    const fp = await fingerprintPublicKey(pk)
    expect(fp).toMatch(/^[0-9a-f]{4} [0-9a-f]{4} [0-9a-f]{4} [0-9a-f]{4}$/)
  })
})

describe("deriveKEK", () => {
  it("rejects an unknown algorithm", async () => {
    await expect(deriveKEK("p", generateSalt(), { ...FAST_PARAMS, algorithm: "scrypt" as never })).rejects.toThrow(
      /Unsupported KDF algorithm/
    )
  })

  it("is deterministic for the same passphrase + salt + params", async () => {
    const salt = generateSalt()
    const k1 = await deriveKEK("hello", salt, FAST_PARAMS)
    const k2 = await deriveKEK("hello", salt, FAST_PARAMS)

    // Two AES-GCM keys decrypted the same way are observationally identical
    // when they encrypt the same plaintext to the same ciphertext (modulo IV).
    // Easier check: round-trip through an explicit encrypt/decrypt.
    const iv = new Uint8Array(12)
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, k1, new Uint8Array([1, 2, 3])))
    const pt = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, k2, ct))
    expect(Array.from(pt)).toEqual([1, 2, 3])
  })
})
