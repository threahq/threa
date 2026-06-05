import { base64ToBytes, bytesToBase64 } from "@threa/crypto"
import { unwrapPrivate, wrapPrivate } from "./keys"

/**
 * Biometric device quick-unlock via the WebAuthn PRF extension.
 *
 * A passkey/biometric authenticator deterministically derives a high-entropy
 * secret (the PRF output) for a given salt. We use that secret directly as the
 * AES-GCM key-encryption key wrapping the UIK private key — so the wrapped key
 * is cryptographically bound to the authenticator and only the device's
 * biometric (user verification) can reproduce it. No Argon2 is needed: the PRF
 * output is already uniformly random.
 *
 * Like the PIN path this only guards device-local material; the passphrase stays
 * the recovery root, and PRF support varies by browser/OS/authenticator, so
 * callers must keep the passphrase fallback working.
 *
 * The pure wrap/unwrap helpers below are unit-tested with a synthetic secret;
 * the `navigator.credentials` ceremony is exercised by a Playwright
 * virtual-authenticator E2E (WebAuthn is unavailable in jsdom).
 */

function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(n)
  crypto.getRandomValues(b)
  return b
}

// WebAuthn's BufferSource params reject `Uint8Array<ArrayBufferLike>` under
// TS 5.7+. Copy onto a fresh ArrayBuffer-backed view (same fix as keys.ts).
function buf(x: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(x)
}

/** AES-GCM KEK straight from the 32-byte PRF secret (no KDF — it's already random). */
async function importPrfKek(prfSecret: Uint8Array): Promise<CryptoKey> {
  if (prfSecret.byteLength < 32) throw new Error("PRF secret must be at least 32 bytes")
  return crypto.subtle.importKey("raw", prfSecret.slice(0, 32), { name: "AES-GCM" }, false, ["encrypt", "decrypt"])
}

/** Wrap the UIK private key under the PRF-derived KEK. Returns a base64 bundle. */
export async function wrapPrivateKeyWithPrf(privateKey: CryptoKey, prfSecret: Uint8Array): Promise<string> {
  const kek = await importPrfKek(prfSecret)
  return bytesToBase64(await wrapPrivate(privateKey, kek))
}

/** Recover the UIK private key from a PRF-wrapped bundle. */
export async function unwrapPrivateKeyWithPrf(bundleB64: string, prfSecret: Uint8Array): Promise<CryptoKey> {
  const kek = await importPrfKek(prfSecret)
  return unwrapPrivate(base64ToBytes(bundleB64), kek)
}

/** Coarse capability gate; the real PRF support is only known after a ceremony. */
export function isWebAuthnAvailable(): boolean {
  return typeof window !== "undefined" && !!window.PublicKeyCredential && !!navigator.credentials?.create
}

/**
 * True only when a *platform* authenticator (Touch ID / Face / Windows Hello /
 * Android biometrics) is actually present and usable. `isWebAuthnAvailable()`
 * only proves the WebAuthn API exists — which many desktop browsers expose with
 * no platform authenticator attached, so gating the biometric affordance on it
 * offers a button that can only fail (UX-30). This is async (a browser probe)
 * and resolves false on any error or where the API is absent.
 */
export async function isPlatformAuthenticatorAvailable(): Promise<boolean> {
  if (!isWebAuthnAvailable()) return false
  try {
    return await window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()
  } catch {
    return false
  }
}

export interface PrfRegistration {
  /** base64 of the credential's raw id — stored to address it on unlock. */
  credentialId: string
  /** base64 PRF salt (the eval input) — not secret; stored to reproduce the secret. */
  prfSalt: string
  /** The PRF output to wrap the key under right now. Never stored. */
  prfSecret: Uint8Array
}

/**
 * Register a resident passkey with the PRF extension and obtain its PRF secret
 * for a fresh salt. PRF results aren't reliably returned at create time across
 * authenticators, so we always follow with a get() to read the secret — the
 * same call unlock uses later. Throws if the user cancels or the authenticator
 * doesn't support PRF.
 */
export async function registerPrfCredential(opts: {
  rpId: string
  rpName: string
  userId: Uint8Array
  userName: string
}): Promise<PrfRegistration> {
  const created = (await navigator.credentials.create({
    publicKey: {
      rp: { id: opts.rpId, name: opts.rpName },
      user: { id: buf(opts.userId), name: opts.userName, displayName: opts.userName },
      challenge: randomBytes(32),
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },
        { type: "public-key", alg: -257 },
      ],
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      extensions: { prf: {} },
    },
  })) as PublicKeyCredential | null
  if (!created) throw new Error("Biometric setup was cancelled")

  const credentialId = bytesToBase64(new Uint8Array(created.rawId))
  const prfSalt = bytesToBase64(randomBytes(32))
  const prfSecret = await getPrfSecret(credentialId, prfSalt)
  return { credentialId, prfSalt, prfSecret }
}

/**
 * Run a WebAuthn assertion (user verification = biometric) and read the PRF
 * secret for `prfSalt`. Throws if cancelled or the authenticator returns no PRF
 * result — callers fall back to the passphrase.
 */
export async function getPrfSecret(credentialIdB64: string, prfSaltB64: string): Promise<Uint8Array> {
  const asserted = (await navigator.credentials.get({
    publicKey: {
      challenge: randomBytes(32),
      allowCredentials: [{ type: "public-key", id: buf(base64ToBytes(credentialIdB64)) }],
      userVerification: "required",
      extensions: { prf: { eval: { first: buf(base64ToBytes(prfSaltB64)) } } },
    },
  })) as PublicKeyCredential | null
  if (!asserted) throw new Error("Biometric unlock was cancelled")
  const ext = asserted.getClientExtensionResults() as { prf?: { results?: { first?: ArrayBuffer } } }
  const first = ext.prf?.results?.first
  if (!first) throw new Error("This device's authenticator didn't return a biometric secret")
  return new Uint8Array(first)
}
