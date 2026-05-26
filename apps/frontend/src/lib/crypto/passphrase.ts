import { argon2id } from "hash-wasm"

/**
 * Passphrase → KEK derivation via Argon2id.
 *
 * Defaults aim at roughly 250 ms on a mid-range phone (a Pixel 6a-class
 * device). The parameters travel with the encrypted bundle so a device that
 * finishes the derivation has everything it needs to repeat it later, even
 * if defaults change.
 */

export interface KdfParams {
  algorithm: "argon2id"
  /** Memory cost in kibibytes (Argon2 `m`). */
  m: number
  /** Iteration count (Argon2 `t`). */
  t: number
  /** Parallelism degree (Argon2 `p`). */
  p: number
  /** Argon2 algorithm version. 19 = `0x13`, current as of RFC 9106. */
  version: number
}

export const DEFAULT_KDF_PARAMS: KdfParams = {
  algorithm: "argon2id",
  m: 64 * 1024, // 64 MiB
  t: 3,
  p: 1,
  version: 19,
}

/** Always 256-bit output: matches our AES-256-GCM wrap key length. */
const KEK_LENGTH_BYTES = 32

/**
 * Derive a 32-byte KEK from a passphrase + salt using Argon2id. The KEK is
 * imported as a non-extractable AES-GCM `CryptoKey` so a bug elsewhere can't
 * accidentally exfiltrate it.
 */
export async function deriveKEK(
  passphrase: string,
  salt: Uint8Array,
  params: KdfParams = DEFAULT_KDF_PARAMS
): Promise<CryptoKey> {
  if (params.algorithm !== "argon2id") {
    throw new Error(`Unsupported KDF algorithm: ${params.algorithm}`)
  }

  const raw = (await argon2id({
    password: passphrase,
    salt,
    iterations: params.t,
    parallelism: params.p,
    memorySize: params.m,
    hashLength: KEK_LENGTH_BYTES,
    outputType: "binary",
  })) as Uint8Array
  // Copy into a fresh ArrayBuffer-backed Uint8Array so WebCrypto's `BufferSource`
  // typing accepts it — hash-wasm returns `Uint8Array<ArrayBufferLike>`.
  const rawBuf = new Uint8Array(raw)

  return crypto.subtle.importKey("raw", rawBuf, { name: "AES-GCM" }, false, ["encrypt", "decrypt"])
}

/**
 * Generate a fresh random KDF salt. 16 bytes is the standard for Argon2.
 */
export function generateSalt(): Uint8Array {
  const salt = new Uint8Array(16)
  crypto.getRandomValues(salt)
  return salt
}
