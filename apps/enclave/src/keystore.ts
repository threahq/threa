import * as fs from "fs"
import { ulid } from "ulid"
import {
  base64ToBytes,
  bytesToBase64,
  exportPrivateKey,
  exportPublicKey,
  generateKeyPair,
  importRecipientPrivateKey,
} from "@threa/crypto"
import pino from "pino"

const logger = pino({ name: "enclave-keystore" })

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

interface PersistedKey {
  instanceId: string
  keyId: string
  publicKey: string
  privateKey: string
}

/**
 * Generate this instance's Enclave Instance Key. Stays in memory for the
 * process lifetime; rotation is per-instance and means restarting the
 * process (the new boot tombstones the old row via heartbeat staleness).
 *
 * **Dev only:** when `ENCLAVE_KEY_PERSIST_PATH` is set, the keypair is loaded
 * from (or saved to) that file so `node --watch` restarts keep the same EIK —
 * otherwise every restart mints a fresh key, invalidating every stream's SSK
 * wrap and silently dropping E2E turns. Production never sets this var, so the
 * key stays ephemeral (a compromised host can't decrypt past the live process).
 */
export async function createEnclaveKeyPair(): Promise<EnclaveKeyPair> {
  const persistPath = process.env.ENCLAVE_KEY_PERSIST_PATH

  if (persistPath) {
    const loaded = await loadPersistedKey(persistPath)
    if (loaded) {
      logger.warn({ keyId: loaded.keyId, persistPath }, "Loaded persisted EIK (dev) — key is NOT ephemeral")
      return loaded
    }
  }

  const pair = await generateKeyPair()
  const publicKey = await exportPublicKey(pair.publicKey)
  const keyPair: EnclaveKeyPair = {
    instanceId: `enci_${ulid()}`,
    keyId: `eik_${ulid()}`,
    publicKeyBase64: bytesToBase64(publicKey),
    publicKey,
    privateKey: pair.privateKey,
  }

  if (persistPath) {
    await savePersistedKey(persistPath, keyPair, pair.privateKey)
    logger.warn({ keyId: keyPair.keyId, persistPath }, "Persisted a fresh EIK (dev) — key is NOT ephemeral")
  }

  return keyPair
}

async function loadPersistedKey(persistPath: string): Promise<EnclaveKeyPair | null> {
  if (!fs.existsSync(persistPath)) return null
  try {
    const parsed = JSON.parse(fs.readFileSync(persistPath, "utf-8")) as PersistedKey
    const publicKey = base64ToBytes(parsed.publicKey)
    // Re-import extractable (matches a freshly generated key); the enclave only
    // uses it to `open` HPKE envelopes.
    const privateKey = await importRecipientPrivateKey(base64ToBytes(parsed.privateKey))
    return {
      instanceId: parsed.instanceId,
      keyId: parsed.keyId,
      publicKeyBase64: parsed.publicKey,
      publicKey,
      privateKey,
    }
  } catch (err) {
    // A corrupt/incompatible file shouldn't wedge boot — fall back to a fresh key.
    logger.warn({ err, persistPath }, "Failed to load persisted EIK; generating a fresh one")
    return null
  }
}

async function savePersistedKey(persistPath: string, keyPair: EnclaveKeyPair, privateKey: CryptoKey): Promise<void> {
  const privateBytes = await exportPrivateKey(privateKey)
  const record: PersistedKey = {
    instanceId: keyPair.instanceId,
    keyId: keyPair.keyId,
    publicKey: keyPair.publicKeyBase64,
    privateKey: bytesToBase64(privateBytes),
  }
  fs.writeFileSync(persistPath, JSON.stringify(record), { mode: 0o600 })
}
