import { INTERNAL_API_KEY_HEADER, type EnclaveSessionResult } from "@threa/types"
import type { EnclaveConfig } from "../config"

/**
 * The enclave's calls back to the regional backend while it owns an assigned
 * session: liveness refresh and the completion ack (sealed replies). Same shared
 * internal-api-key the enclave uses for register/heartbeat/revoke. Bodies are
 * ciphertext only — the backend never receives plaintext.
 */

export interface BackendCallbacks {
  /** Refresh the session's heartbeat so orphan-cleanup doesn't reclaim it mid-turn. */
  heartbeat(sessionId: string): Promise<void>
  /** Hand back the sealed replies and mark the session complete. */
  complete(sessionId: string, result: EnclaveSessionResult): Promise<void>
}

const HEARTBEAT_TIMEOUT_MS = 10_000
const COMPLETE_TIMEOUT_MS = 30_000

export function createBackendCallbacks(config: EnclaveConfig): BackendCallbacks {
  const base = config.backendBaseUrl
  const headers = {
    "Content-Type": "application/json",
    [INTERNAL_API_KEY_HEADER]: config.internalApiKey,
  }

  return {
    async heartbeat(sessionId) {
      const res = await fetch(`${base}/internal/enclave-runtimes/sessions/${sessionId}/heartbeat`, {
        method: "POST",
        headers,
        signal: AbortSignal.timeout(HEARTBEAT_TIMEOUT_MS),
      })
      if (!res.ok) throw new Error(`session heartbeat failed: ${res.status}`)
    },

    async complete(sessionId, result) {
      const res = await fetch(`${base}/internal/enclave-runtimes/sessions/${sessionId}/complete`, {
        method: "POST",
        headers,
        body: JSON.stringify(result),
        signal: AbortSignal.timeout(COMPLETE_TIMEOUT_MS),
      })
      if (!res.ok) throw new Error(`session complete failed: ${res.status}`)
    },
  }
}
