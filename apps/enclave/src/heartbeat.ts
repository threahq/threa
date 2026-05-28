import pino from "pino"
import type { EnclaveConfig } from "./config"
import type { EnclaveKeyPair } from "./keystore"

const logger = pino({ name: "enclave-heartbeat" })

export interface Heartbeat {
  stop: () => void
}

/**
 * Sends a heartbeat to the backend on the configured interval. If the backend
 * returns 404, the row was tombstoned (likely because we restarted faster
 * than staleness eviction) — re-register and continue.
 *
 * Heartbeat failures other than 404 are logged and the next tick retries;
 * this matches the staleness contract (backend treats us as live until
 * `last_seen_at + 2min`).
 */
export function startHeartbeat(
  config: EnclaveConfig,
  keyPair: EnclaveKeyPair,
  onReregisterNeeded: () => Promise<void>
): Heartbeat {
  const timer = setInterval(async () => {
    try {
      const res = await fetch(`${config.backendBaseUrl}/internal/enclave-runtimes/heartbeat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.internalApiKey}`,
        },
        body: JSON.stringify({ keyId: keyPair.keyId }),
      })
      if (res.status === 404) {
        logger.warn({ keyId: keyPair.keyId }, "Heartbeat: row tombstoned, re-registering")
        await onReregisterNeeded()
        return
      }
      if (!res.ok) {
        logger.warn({ status: res.status }, "Heartbeat returned non-ok status")
      }
    } catch (err) {
      logger.warn({ err }, "Heartbeat request failed")
    }
  }, config.heartbeatIntervalMs)

  return {
    stop: () => clearInterval(timer),
  }
}
