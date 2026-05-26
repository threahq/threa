import { describe, expect, it } from "vitest"
import { generateUIK, unwrapPrivate, wrapPrivate } from "../keys"
import { deriveKEK, generateSalt, DEFAULT_KDF_PARAMS } from "../passphrase"
import { encryptPayload, decryptPayloadAsString } from "../envelope"

// Argon2id on the desktop CI runs in ~50ms with the defaults below; tighten
// further if test runtime becomes an issue. Real-device benchmarks happen in
// the setup modal, not here.
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
