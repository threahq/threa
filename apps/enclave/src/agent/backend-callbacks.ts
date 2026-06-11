import {
  INTERNAL_API_KEY_HEADER,
  type SealedReply,
  type EnclaveSealedName,
  type SealedStep,
  type SealedStepStart,
  type EnclaveSealedSubstep,
  type EnclaveSessionResult,
  type EnclaveSessionFailure,
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
  message(sessionId: string, reply: SealedReply): Promise<void>
  /** Open one in-flight sealed trace step the moment the loop starts it (persisted + broadcast now). */
  stepStarted(sessionId: string, step: SealedStepStart): Promise<void>
  /** Finalize one sealed trace step in place the moment it completes (persisted + broadcast now). */
  step(sessionId: string, step: SealedStep): Promise<void>
  /** Stream one sealed substep — ephemeral mid-run phase text (broadcast only, not persisted). */
  substep(sessionId: string, substep: EnclaveSealedSubstep): Promise<void>
  /** Mark the session complete once the loop finishes (replies already streamed). */
  complete(sessionId: string, result: EnclaveSessionResult): Promise<void>
  /** Terminate the session promptly when the loop throws — scrubbed error metadata only, never plaintext. */
  fail(sessionId: string, failure: EnclaveSessionFailure): Promise<void>
  /** Persist a sealed auto-generated stream title (best-effort; for untitled E2E scratchpads). */
  sealedName(sessionId: string, sealed: EnclaveSealedName): Promise<void>
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

    async stepStarted(sessionId, step) {
      const res = await fetch(`${base}/internal/enclave-runtimes/sessions/${sessionId}/steps/started`, {
        method: "POST",
        headers,
        body: JSON.stringify(step),
        signal: AbortSignal.timeout(STEP_TIMEOUT_MS),
      })
      if (!res.ok) throw new Error(`session step:started failed: ${res.status}`)
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

    async substep(sessionId, substep) {
      const res = await fetch(`${base}/internal/enclave-runtimes/sessions/${sessionId}/substeps`, {
        method: "POST",
        headers,
        body: JSON.stringify(substep),
        signal: AbortSignal.timeout(STEP_TIMEOUT_MS),
      })
      if (!res.ok) throw new Error(`session substep failed: ${res.status}`)
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

    async fail(sessionId, failure) {
      const res = await fetch(`${base}/internal/enclave-runtimes/sessions/${sessionId}/fail`, {
        method: "POST",
        headers,
        body: JSON.stringify(failure),
        signal: AbortSignal.timeout(COMPLETE_TIMEOUT_MS),
      })
      if (!res.ok) throw new Error(`session fail failed: ${res.status}`)
    },

    async sealedName(sessionId, sealed) {
      const res = await fetch(`${base}/internal/enclave-runtimes/sessions/${sessionId}/sealed-name`, {
        method: "POST",
        headers,
        body: JSON.stringify(sealed),
        signal: AbortSignal.timeout(MESSAGE_TIMEOUT_MS),
      })
      if (!res.ok) throw new Error(`session sealed-name failed: ${res.status}`)
    },
  }
}
