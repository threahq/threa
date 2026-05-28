import { Aes256Gcm, CipherSuite, DhkemX25519HkdfSha256, HkdfSha256 } from "@hpke/core"

/**
 * RFC 9180 HPKE wrappers around `@hpke/core`.
 *
 * Suite: `DHKEM(X25519, HKDF-SHA256)` + `HKDF-SHA256` + `AES-256-GCM`. Picked
 * for browser/Bun parity and audited library coverage. The suite is held in a
 * module-level singleton — it is stateless and cheap to reuse.
 *
 * The "private key never leaves the browser" rule is enforced by callers:
 * this module only ever returns CryptoKey objects; the lifecycle (Dexie
 * persistence of the *wrapped* private key, in-memory unwrapped key) lives
 * in the frontend's `keys.ts` and the e2e session store.
 */

let suite: CipherSuite | null = null

export function getSuite(): CipherSuite {
  if (!suite) {
    suite = new CipherSuite({
      kem: new DhkemX25519HkdfSha256(),
      kdf: new HkdfSha256(),
      aead: new Aes256Gcm(),
    })
  }
  return suite
}

/** Convenience accessors that map onto the underlying `@hpke/core` interfaces. */

export async function generateKeyPair(): Promise<CryptoKeyPair> {
  return getSuite().kem.generateKeyPair()
}

export async function importRecipientPublicKey(raw: Uint8Array | ArrayBuffer): Promise<CryptoKey> {
  const buf = raw instanceof Uint8Array ? raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) : raw
  return getSuite().kem.deserializePublicKey(buf)
}

/**
 * PKCS#8 prefix for an X25519 private key: the fixed ASN.1 header that wraps
 * the 32 raw private bytes. `@hpke/core`'s own X25519 primitive uses the same
 * constant; we duplicate it here so the non-extractable import path can call
 * `crypto.subtle.importKey` directly (the library's `deserializePrivateKey`
 * always imports as extractable).
 */
const PKCS8_ALG_ID_X25519 = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20,
])

/**
 * Import the serialized X25519 private key for `hpke.open`.
 *
 * Pass `{ extractable: false }` to get a CryptoKey whose raw bytes can never
 * be read back out (`crypto.subtle.exportKey` rejects) — it stays usable for
 * decryption via `deriveBits`. This is the form persisted to IndexedDB for
 * "keep me unlocked on this device": even with the IDB record, an attacker
 * cannot recover the private key material. The default (`extractable: true`)
 * matches the underlying library and is what rotation needs to re-wrap.
 */
export async function importRecipientPrivateKey(
  raw: Uint8Array | ArrayBuffer,
  opts?: { extractable?: boolean }
): Promise<CryptoKey> {
  const buf = raw instanceof Uint8Array ? raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) : raw
  if (opts?.extractable === false) {
    const rawPriv = new Uint8Array(buf)
    const pkcs8 = new Uint8Array(PKCS8_ALG_ID_X25519.length + rawPriv.length)
    pkcs8.set(PKCS8_ALG_ID_X25519, 0)
    pkcs8.set(rawPriv, PKCS8_ALG_ID_X25519.length)
    return crypto.subtle.importKey("pkcs8", pkcs8, { name: "X25519" }, false, ["deriveBits"])
  }
  return getSuite().kem.deserializePrivateKey(buf)
}

export async function exportPublicKey(key: CryptoKey): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await getSuite().kem.serializePublicKey(key))
}

export async function exportPrivateKey(key: CryptoKey): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await getSuite().kem.serializePrivateKey(key))
}

export interface SealResult {
  /** HPKE encapsulation (KEM output) — needed by the recipient to derive shared secret. */
  enc: Uint8Array<ArrayBuffer>
  /** AEAD ciphertext. */
  ct: Uint8Array<ArrayBuffer>
}

/**
 * "Encrypt to public key": wrap `plaintext` so only the holder of the
 * corresponding private key can read it. Single-shot — for multi-message
 * conversations build per-message envelopes instead of reusing a context.
 */
export async function seal(params: {
  recipientPublicKey: CryptoKey
  plaintext: Uint8Array
  aad?: Uint8Array
}): Promise<SealResult> {
  const response = await getSuite().seal(
    { recipientPublicKey: params.recipientPublicKey },
    params.plaintext,
    params.aad
  )
  return {
    enc: new Uint8Array(response.enc),
    ct: new Uint8Array(response.ct),
  }
}

/**
 * Decrypt an HPKE-sealed payload. Throws if `aad` does not match what the
 * sender used (the GCM tag fails verification).
 */
export async function open(params: {
  recipientPrivateKey: CryptoKey
  enc: Uint8Array
  ct: Uint8Array
  aad?: Uint8Array
}): Promise<Uint8Array<ArrayBuffer>> {
  const buf = await getSuite().open(
    { recipientKey: params.recipientPrivateKey, enc: params.enc },
    params.ct,
    params.aad
  )
  return new Uint8Array(buf)
}
