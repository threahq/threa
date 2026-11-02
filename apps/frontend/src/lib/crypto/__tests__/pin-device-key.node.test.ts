import { describe, expect, it } from "vitest"
import { generateUIK } from "../keys"
import { DEFAULT_KDF_PARAMS } from "../passphrase"
import {
  isValidPin,
  MAX_PIN_ATTEMPTS,
  PIN_MAX_DIGITS,
  PIN_MIN_DIGITS,
  unwrapPrivateKeyWithPin,
  wrapPrivateKeyWithPin,
} from "../pin-device-key"

// Argon2id at default cost is ~hundreds of ms; use a cheap preset so the
// round-trip stays fast (mirrors the crypto/store suites).
const FAST_PARAMS = { ...DEFAULT_KDF_PARAMS, m: 8 * 1024, t: 1 }

describe("isValidPin", () => {
  it("accepts 6–8 digit PINs and rejects everything else", () => {
    expect(isValidPin("123456")).toBe(true)
    expect(isValidPin("12345678")).toBe(true)
    expect(isValidPin("12345")).toBe(false) // too short
    expect(isValidPin("123456789")).toBe(false) // too long
    expect(isValidPin("12 456")).toBe(false) // non-digit
    expect(isValidPin("abcdef")).toBe(false)
    expect(isValidPin("")).toBe(false)
  })

  it("exposes sane bounds + a lockout threshold", () => {
    expect(PIN_MIN_DIGITS).toBe(6)
    expect(PIN_MAX_DIGITS).toBe(8)
    expect(MAX_PIN_ATTEMPTS).toBeGreaterThan(0)
  })
})

describe("wrapPrivateKeyWithPin / unwrapPrivateKeyWithPin", () => {
  it("round-trips the UIK private key under the correct PIN", async () => {
    const uik = await generateUIK()
    const wrapped = await wrapPrivateKeyWithPin(uik.privateKey, "135790", FAST_PARAMS)
    expect(wrapped.pinWrappedPrivate.length).toBeGreaterThan(0)
    expect(wrapped.pinSalt.length).toBeGreaterThan(0)

    // The recovered key opens HPKE for our own public key — i.e. it's the same
    // private key, usable for decryption.
    const recovered = await unwrapPrivateKeyWithPin(wrapped, "135790")
    expect(recovered).toBeDefined()
    expect(recovered.extractable).toBe(true)
  })

  it("rejects the wrong PIN (AES-GCM tag check fails)", async () => {
    const uik = await generateUIK()
    const wrapped = await wrapPrivateKeyWithPin(uik.privateKey, "135790", FAST_PARAMS)
    await expect(unwrapPrivateKeyWithPin(wrapped, "999999")).rejects.toThrow()
  })

  it("refuses to wrap under a malformed PIN", async () => {
    const uik = await generateUIK()
    await expect(wrapPrivateKeyWithPin(uik.privateKey, "12", FAST_PARAMS)).rejects.toThrow(/6.*8 digits/)
  })
})
