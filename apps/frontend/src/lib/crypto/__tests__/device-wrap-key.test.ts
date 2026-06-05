import { describe, expect, it } from "vitest"
import { decryptPayloadAsString, encryptPayload } from "@threa/crypto"
import { generateUIK } from "../keys"
import { unwrapPrivateKeyFromDevice, wrapPrivateKeyForDevice } from "../device-wrap-key"

describe("wrapPrivateKeyForDevice / unwrapPrivateKeyFromDevice", () => {
  it("round-trips the UIK private key so the recovered key still decrypts", async () => {
    const uik = await generateUIK()
    const wrapped = await wrapPrivateKeyForDevice(uik.privateKey)
    expect(wrapped.deviceWrappedPrivate.length).toBeGreaterThan(0)

    const recovered = await unwrapPrivateKeyFromDevice(wrapped)
    const { envelope } = await encryptPayload({
      payload: "secret",
      recipients: [{ recipientKeyId: "e2ek_self", publicKey: uik.publicKey }],
    })
    expect(await decryptPayloadAsString({ envelope, privateKey: recovered, recipientKeyId: "e2ek_self" })).toBe(
      "secret"
    )
  })

  it("seals under a non-extractable AES-GCM key that can never be exported", async () => {
    const uik = await generateUIK()
    const { deviceWrapKey } = await wrapPrivateKeyForDevice(uik.privateKey)
    expect(deviceWrapKey.algorithm.name).toBe("AES-GCM")
    expect(deviceWrapKey.extractable).toBe(false)
    await expect(crypto.subtle.exportKey("raw", deviceWrapKey)).rejects.toThrow()
  })

  it("fails to unwrap when the sealed bytes are tampered with", async () => {
    const uik = await generateUIK()
    const wrapped = await wrapPrivateKeyForDevice(uik.privateKey)
    const tampered = { ...wrapped, deviceWrappedPrivate: "AAAA" + wrapped.deviceWrappedPrivate.slice(4) }
    await expect(unwrapPrivateKeyFromDevice(tampered)).rejects.toThrow()
  })

  it("fails to unwrap with a different device key (the AES-GCM tag check)", async () => {
    const uik = await generateUIK()
    const a = await wrapPrivateKeyForDevice(uik.privateKey)
    const b = await wrapPrivateKeyForDevice(uik.privateKey)
    // Pair A's ciphertext with B's key — the GCM tag must reject it.
    await expect(
      unwrapPrivateKeyFromDevice({ deviceWrapKey: b.deviceWrapKey, deviceWrappedPrivate: a.deviceWrappedPrivate })
    ).rejects.toThrow()
  })
})
