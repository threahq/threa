import pino from "pino"
import { INTERNAL_API_KEY_HEADER } from "@threa/types"
import type { EnclaveConfig } from "./config"
import type { EnclaveKeyPair } from "./keystore"

const logger = pino({ name: "enclave-register" })

/**
 * Registers this instance's EIK with the backend. Idempotent: backend's
 * `register-key` upserts on `key_id`, and since each process boot generates a
 * fresh key, this only ever inserts.
 */
export async function registerWithBackend(config: EnclaveConfig, keyPair: EnclaveKeyPair): Promise<void> {
  const res = await fetch(`${config.backendBaseUrl}/internal/enclave-runtimes/register-key`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      [INTERNAL_API_KEY_HEADER]: config.internalApiKey,
    },
    body: JSON.stringify({
      instanceId: keyPair.instanceId,
      keyId: keyPair.keyId,
      publicKey: keyPair.publicKeyBase64,
      instanceUrl: config.selfUrl,
    }),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(`Enclave registration failed (${res.status}): ${body}`)
  }
  logger.info({ instanceId: keyPair.instanceId, keyId: keyPair.keyId }, "Enclave registered with backend")
}

/**
 * Best-effort graceful revoke on shutdown. Heartbeat staleness will tombstone
 * the row within 2 minutes regardless, so a failure here is non-fatal.
 */
export async function revokeWithBackend(config: EnclaveConfig, keyPair: EnclaveKeyPair): Promise<void> {
  try {
    await fetch(`${config.backendBaseUrl}/internal/enclave-runtimes/revoke`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [INTERNAL_API_KEY_HEADER]: config.internalApiKey,
      },
      body: JSON.stringify({ keyId: keyPair.keyId }),
    })
    logger.info({ keyId: keyPair.keyId }, "Enclave revoked with backend")
  } catch (err) {
    logger.warn({ err, keyId: keyPair.keyId }, "Enclave revoke failed (non-fatal — staleness will tombstone)")
  }
}
