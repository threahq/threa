import {
  INTERNAL_API_KEY_HEADER,
  type EnclaveSealedReply,
  type EnclaveSealedStep,
  type EnclaveSessionResult,
} from "@threa/types"
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
  /** Stream one sealed reply back the moment the loop sends it (written + broadcast now). */
  message(sessionId: string, reply: EnclaveSealedReply): Promise<void>
  /** Stream one sealed trace step back the moment the loop emits it (persisted + broadcast now). */
  step(sessionId: string, step: EnclaveSealedStep): Promise<void>
  /** Mark the session complete once the loop finishes (replies already streamed). */
  complete(sessionId: string, result: EnclaveSessionResult): Promise<void>
}

const HEARTBEAT_TIMEOUT_MS = 10_000
const MESSAGE_TIMEOUT_MS = 30_000
const STEP_TIMEOUT_MS = 30_000
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

    async message(sessionId, reply) {
      const res = await fetch(`${base}/internal/enclave-runtimes/sessions/${sessionId}/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify(reply),
        signal: AbortSignal.timeout(MESSAGE_TIMEOUT_MS),
      })
      if (!res.ok) throw new Error(`session message failed: ${res.status}`)
    },

    async step(sessionId, step) {
      const res = await fetch(`${base}/internal/enclave-runtimes/sessions/${sessionId}/steps`, {
        method: "POST",
        headers,
        body: JSON.stringify(step),
        signal: AbortSignal.timeout(STEP_TIMEOUT_MS),
      })
      if (!res.ok) throw new Error(`session step failed: ${res.status}`)
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
