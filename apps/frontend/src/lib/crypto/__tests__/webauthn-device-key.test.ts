import { describe, expect, it } from "vitest"
import { generateUIK } from "../keys"
import { unwrapPrivateKeyWithPrf, wrapPrivateKeyWithPrf } from "../webauthn-device-key"

// The PRF secret is a uniformly-random 32 bytes the authenticator would return;
// the ceremony itself (navigator.credentials) is covered by the Playwright
// virtual-authenticator E2E. Here we verify the pure wrap/unwrap around it.
function fakePrfSecret(seed: number): Uint8Array {
  const b = new Uint8Array(32)
  for (let i = 0; i < 32; i++) b[i] = (seed + i * 7) % 256
  return b
}

describe("wrapPrivateKeyWithPrf / unwrapPrivateKeyWithPrf", () => {
  it("round-trips the UIK private key under the PRF secret", async () => {
    const uik = await generateUIK()
    const secret = fakePrfSecret(1)
    const bundle = await wrapPrivateKeyWithPrf(uik.privateKey, secret)
    expect(bundle.length).toBeGreaterThan(0)

    const recovered = await unwrapPrivateKeyWithPrf(bundle, secret)
    expect(recovered).toBeDefined()
    expect(recovered.extractable).toBe(false)
  })

  it("fails to unwrap under a different PRF secret (AES-GCM tag check)", async () => {
    const uik = await generateUIK()
    const bundle = await wrapPrivateKeyWithPrf(uik.privateKey, fakePrfSecret(1))
    await expect(unwrapPrivateKeyWithPrf(bundle, fakePrfSecret(2))).rejects.toThrow()
  })

  it("rejects a too-short PRF secret", async () => {
    const uik = await generateUIK()
    await expect(wrapPrivateKeyWithPrf(uik.privateKey, new Uint8Array(16))).rejects.toThrow(/at least 32/)
  })
})
