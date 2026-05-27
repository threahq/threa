import { ulid } from "ulid"
import { bytesToBase64, exportPublicKey, generateKeyPair } from "@threa/crypto"

export interface EnclaveKeyPair {
  /** Stable identifier for this instance (one per process lifetime). */
  instanceId: string
  /** Identifier the backend stores in `enclave_runtimes.key_id` and that messages address. */
  keyId: string
  /** Raw X25519 public key, base64-encoded for wire/registration. */
  publicKeyBase64: string
  publicKey: Uint8Array
  /** HPKE private key — never leaves this process. */
  privateKey: CryptoKey
}

/**
 * Generate this instance's Enclave Instance Key. Stays in memory for the
 * process lifetime; rotation is per-instance and means restarting the
 * process (the new boot tombstones the old row via heartbeat staleness).
 */
export async function createEnclaveKeyPair(): Promise<EnclaveKeyPair> {
  const pair = await generateKeyPair()
  const publicKey = await exportPublicKey(pair.publicKey)
  return {
    instanceId: `enci_${ulid()}`,
    keyId: `eik_${ulid()}`,
    publicKeyBase64: bytesToBase64(publicKey),
    publicKey,
    privateKey: pair.privateKey,
  }
}
