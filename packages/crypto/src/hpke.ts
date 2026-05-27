import { Aes256Gcm, CipherSuite, HkdfSha256 } from "@hpke/core"
import { DhkemX25519HkdfSha256 } from "@hpke/dhkem-x25519"

/**
 * RFC 9180 HPKE wrappers around `@hpke/core`.
 *
 * Suite: `DHKEM(X25519, HKDF-SHA256)` + `HKDF-SHA256` + `AES-256-GCM`. The KEM
 * comes from `@hpke/dhkem-x25519` (noble-curves backed) instead of
 * `@hpke/core` because Bun 1.3's WebCrypto does not yet implement X25519
 * seal/open — the noble-backed KEM works in both the browser and the
 * enclave's Bun runtime. The suite is held in a module-level singleton —
 * it is stateless and cheap to reuse.
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

export async function importRecipientPrivateKey(raw: Uint8Array | ArrayBuffer): Promise<CryptoKey> {
  const buf = raw instanceof Uint8Array ? raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) : raw
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
