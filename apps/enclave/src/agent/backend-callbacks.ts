import {
  ENCLAVE_CALLBACK_TOKEN_HEADER,
  INTERNAL_API_KEY_HEADER,
  type EnclaveMidTurnMessage,
  type EnclaveNamingDecision,
  type EnclaveMidTurnMessagesResponse,
  type EnclaveSessionHeartbeatResponse,
  type SealedReply,
  type EnclaveSealedSummary,
  type SealedStep,
  type SealedStepStart,
  type EnclaveSealedSubstep,
  type EnclaveSessionResult,
  type EnclaveSessionFailure,
} from "@threahq/types"
import type { EnclaveConfig } from "../config"

/**
 * The enclave's calls back to the regional backend while it owns an assigned
 * session: liveness refresh and the completion ack (sealed replies). Same shared
 * internal-api-key the enclave uses for register/heartbeat/revoke. Bodies are
 * ciphertext only — the backend never receives plaintext.
 */

export interface BackendCallbacks {
  /**
   * Refresh the session's heartbeat so orphan-cleanup doesn't reclaim it
   * mid-turn. The response carries the abort flag (§2.7: a user's "Stop
   * research" rides the pull channel — there is no inbound cancel route).
   */
  heartbeat(sessionId: string): Promise<EnclaveSessionHeartbeatResponse>
  /** Stream one sealed reply back the moment the loop sends it (written + broadcast now). */
  message(sessionId: string, reply: SealedReply): Promise<void>
  /**
   * Pull the sealed messages that landed since `afterSequence` (the interjection
   * poll, UX-12). The loop calls this at its reconsider boundaries so a message
   * arriving mid-turn reaches the turn in flight, not only via post-completion
   * catch-up. The backend clamps the floor to the trigger, so a `0` cursor is
   * safe; the rows come back sealed and the enclave opens them with the SSK it
   * already holds.
   */
  pollMessages(sessionId: string, afterSequence: bigint): Promise<EnclaveMidTurnMessage[]>
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
  /** Apply a revision-fenced sealed dynamic naming decision. */
  namingDecision(sessionId: string, decision: EnclaveNamingDecision): Promise<void>
  /** Persist the sealed rolling conversation summary (best-effort; C-2). */
  sealedSummary(sessionId: string, sealed: EnclaveSealedSummary): Promise<void>
}

const HEARTBEAT_TIMEOUT_MS = 10_000
const MESSAGE_TIMEOUT_MS = 30_000
const STEP_TIMEOUT_MS = 30_000
const COMPLETE_TIMEOUT_MS = 30_000

export function createBackendCallbacks(config: EnclaveConfig, callbackToken?: string): BackendCallbacks {
  const base = config.backendBaseUrl
  const headers = {
    "Content-Type": "application/json",
    [INTERNAL_API_KEY_HEADER]: config.internalApiKey,
    // Per-session binding (Phase 2.4b, E2EE-21): echo the assignment's token
    // so the backend can verify these callbacks come from the assigned runner.
    ...(callbackToken ? { [ENCLAVE_CALLBACK_TOKEN_HEADER]: callbackToken } : {}),
  }

  return {
    async heartbeat(sessionId) {
      const res = await fetch(`${base}/internal/enclave-runtimes/sessions/${sessionId}/heartbeat`, {
        method: "POST",
        headers,
        signal: AbortSignal.timeout(HEARTBEAT_TIMEOUT_MS),
      })
      if (!res.ok) throw new Error(`session heartbeat failed: ${res.status}`)
      // A malformed/empty body is a heartbeat protocol failure, not "no abort":
      // throwing surfaces it (logged by the runner) and the next beat re-reads
      // the (sticky) abort flag, rather than silently masking a pending abort.
      const body = (await res.json()) as EnclaveSessionHeartbeatResponse
      if (typeof body?.abort !== "boolean") throw new Error("session heartbeat returned an invalid body")
      return { abort: body.abort }
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

    async pollMessages(sessionId, afterSequence) {
      const url = `${base}/internal/enclave-runtimes/sessions/${sessionId}/messages?after=${afterSequence.toString()}`
      const res = await fetch(url, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(MESSAGE_TIMEOUT_MS),
      })
      if (!res.ok) throw new Error(`session poll-messages failed: ${res.status}`)
      const body = (await res.json()) as EnclaveMidTurnMessagesResponse
      if (!Array.isArray(body?.messages)) throw new Error("session poll-messages returned an invalid body")
      return body.messages
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

    async namingDecision(sessionId, decision) {
      const res = await fetch(`${base}/internal/enclave-runtimes/sessions/${sessionId}/naming-decision`, {
        method: "POST",
        headers,
        body: JSON.stringify(decision),
        signal: AbortSignal.timeout(MESSAGE_TIMEOUT_MS),
      })
      if (!res.ok) throw new Error(`session naming-decision failed: ${res.status}`)
    },

    async sealedSummary(sessionId, sealed) {
      const res = await fetch(`${base}/internal/enclave-runtimes/sessions/${sessionId}/sealed-summary`, {
        method: "POST",
        headers,
        body: JSON.stringify(sealed),
        signal: AbortSignal.timeout(MESSAGE_TIMEOUT_MS),
      })
      if (!res.ok) throw new Error(`session sealed-summary failed: ${res.status}`)
    },
  }
}
