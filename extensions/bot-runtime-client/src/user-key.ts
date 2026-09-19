import { argon2id } from "hash-wasm"
import { importRecipientPrivateKey, type WebCryptoKey } from "./crypto"

/**
 * Recovering a user's identity key from a passphrase, outside the browser.
 *
 * The web app wraps the UIK's private half in AES-256-GCM under an Argon2id
 * KEK and hands the server nothing but the ciphertext. A CLI on a machine that
 * has never run the web app fetches that bundle from
 * `GET /api/v1/workspaces/{ws}/me/e2e-key` and repeats the derivation here.
 *
 * Every constant below is wire format shared with
 * `apps/frontend/src/lib/crypto/{passphrase,keys}.ts`. `user-key.parity.test.ts`
 * wraps with the browser code and unwraps with this one, so drift fails CI
 * rather than locking someone out of their own streams.
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
  m: 64 * 1024,
  t: 3,
  p: 1,
  version: 19,
}

const KEK_LENGTH_BYTES = 32
const PRIVATE_BUNDLE_VERSION = 1
const IV_LENGTH = 12
const ARGON2_VERSION = 19

/**
 * Derive the 32-byte AES-GCM key-encryption key a wrapped bundle was sealed
 * under. Non-extractable: nothing downstream needs the raw bytes, and the
 * passphrase should not become recoverable material sitting in a variable.
 */
export async function deriveKEK(
  passphrase: string,
  salt: Uint8Array,
  params: KdfParams = DEFAULT_KDF_PARAMS
): Promise<WebCryptoKey> {
  if (params.algorithm !== "argon2id") {
    throw new Error(`Unsupported KDF algorithm: ${params.algorithm}`)
  }
  // hash-wasm implements Argon2 v1.3 only. A bundle asking for anything else
  // would derive a silently wrong KEK and surface as "wrong passphrase".
  if (params.version !== ARGON2_VERSION) {
    throw new Error(`Unsupported Argon2 version: ${params.version}`)
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

  return crypto.subtle.importKey("raw", new Uint8Array(raw), { name: "AES-GCM" }, false, ["decrypt"])
}

/**
 * Open a `[version (1) | iv (12) | AES-GCM ciphertext]` bundle and re-import
 * the X25519 private key. Throws on a tampered bundle or the wrong KEK — the
 * GCM tag is the only passphrase check there is.
 */
export async function unwrapPrivate(bundle: Uint8Array, kek: WebCryptoKey): Promise<WebCryptoKey> {
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

export interface UnlockUserKeyInput {
  passphrase: string
  /** `encryptedPrivateBundle` exactly as the API returns it. */
  encryptedPrivateBundle: Uint8Array
  /** `kdfSalt` exactly as the API returns it. */
  kdfSalt: Uint8Array
  kdfParams: KdfParams
}

/** The whole passphrase → private key path in one call. */
export async function unlockUserKey(input: UnlockUserKeyInput): Promise<WebCryptoKey> {
  const kek = await deriveKEK(input.passphrase, input.kdfSalt, input.kdfParams)
  return unwrapPrivate(input.encryptedPrivateBundle, kek)
}
