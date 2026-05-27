import { exportPrivateKey, exportPublicKey, generateKeyPair, importRecipientPrivateKey } from "@threa/crypto"

/**
 * UIK lifecycle: generate → wrap-with-KEK → store ciphertext on server →
 * pull-back-on-new-device → unwrap-with-KEK → cache in session store.
 *
 * The "wrap" is just AES-256-GCM around the serialized X25519 private key,
 * keyed by the passphrase-derived KEK from `passphrase.ts`. The server only
 * ever sees the ciphertext; the unwrapped private key is never persisted.
 */

const PRIVATE_BUNDLE_VERSION = 1
const IV_LENGTH = 12

export interface UserIdentityKey {
  publicKey: Uint8Array
  privateKey: CryptoKey
}

/**
 * Generate a fresh X25519 keypair and return the serialized public half plus
 * the live CryptoKey for the private half. Callers must wrap-and-persist the
 * private half immediately; once this function returns, the only copy lives
 * in the caller's memory.
 */
export async function generateUIK(): Promise<UserIdentityKey> {
  const pair = await generateKeyPair()
  const publicKey = await exportPublicKey(pair.publicKey)
  return {
    publicKey,
    privateKey: pair.privateKey,
  }
}

/**
 * Wrap a private key with the KEK so the ciphertext is safe to send to the
 * server. The output prepends a 1-byte version tag + 12-byte IV before the
 * AES-GCM ciphertext (which includes the auth tag).
 *
 * Layout: `[version (1 byte) | iv (12 bytes) | ciphertext + gcm tag]`.
 */
export async function wrapPrivate(privateKey: CryptoKey, kek: CryptoKey): Promise<Uint8Array> {
  const privBytes = await exportPrivateKey(privateKey)
  const iv = new Uint8Array(IV_LENGTH)
  crypto.getRandomValues(iv)

  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, kek, privBytes))

  const bundle = new Uint8Array(1 + IV_LENGTH + ciphertext.length)
  bundle[0] = PRIVATE_BUNDLE_VERSION
  bundle.set(iv, 1)
  bundle.set(ciphertext, 1 + IV_LENGTH)
  return bundle
}

/**
 * Decrypt a wrapped private bundle and re-import as a CryptoKey suitable for
 * `hpke.open`. Throws if the bundle was tampered with (GCM tag mismatch) or
 * the KEK is wrong.
 */
export async function unwrapPrivate(bundle: Uint8Array, kek: CryptoKey): Promise<CryptoKey> {
  if (bundle.length < 1 + IV_LENGTH + 1) {
    throw new Error("Wrapped private bundle is too short")
  }
  const version = bundle[0]
  if (version !== PRIVATE_BUNDLE_VERSION) {
    throw new Error(`Unsupported private bundle version: ${version}`)
  }
  const iv = bundle.slice(1, 1 + IV_LENGTH)
  const ciphertext = bundle.slice(1 + IV_LENGTH)
  const privBytes = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, kek, ciphertext))
  return importRecipientPrivateKey(privBytes)
}

/**
 * Short, human-verifiable fingerprint of a public key — SHA-256 of the raw
 * bytes, first 8 bytes, rendered as four 4-character hex groups separated by
 * spaces. Surfaces in the unlock modal so users can confirm which key they're
 * about to unlock against (especially after a cross-device rotation).
 */
export async function fingerprintPublicKey(publicKey: Uint8Array): Promise<string> {
  // Copy onto a fresh ArrayBuffer-backed view so WebCrypto's BufferSource
  // typing accepts it (TS 5.7+ rejects the `ArrayBufferLike` default).
  const input = new Uint8Array(publicKey)
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input))
  const hex = Array.from(digest.slice(0, 8), (b) => b.toString(16).padStart(2, "0")).join("")
  return hex.match(/.{1,4}/g)!.join(" ")
}
