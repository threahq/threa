import pino from "pino"
import type { EnclaveSessionAssignment } from "@threa/types"
import type { EnclaveKeyPair } from "../keystore"
import type { RawChatFn } from "../llm"
import type { BackendCallbacks } from "./backend-callbacks"
import { runEnclaveTurn } from "./run-turn"

const logger = pino({ name: "enclave-session" })

/**
 * Refresh interval for the session heartbeat. The backend reclaims a session
 * whose heartbeat is older than ~60s, so 15s leaves several missed beats of grace.
 */
const HEARTBEAT_INTERVAL_MS = 15_000

export interface SessionRunnerDeps {
  keyPair: EnclaveKeyPair
  rawChat: RawChatFn
  callbacks: BackendCallbacks
}

/**
 * Owns one assigned turn end to end: keeps the session's heartbeat fresh while
 * the agent loop runs, then hands the sealed replies back via `complete`. On
 * failure it stops heartbeating and lets the backend's orphan-cleanup reclaim
 * the session (an explicit fail callback + resume are later slices). Plaintext
 * lives only in `runEnclaveTurn`, for the duration of the loop.
 */
export async function runEnclaveSession(deps: SessionRunnerDeps, assignment: EnclaveSessionAssignment): Promise<void> {
  const { sessionId } = assignment

  const heartbeat = setInterval(() => {
    void deps.callbacks.heartbeat(sessionId).catch((err) => {
      logger.warn({ err, sessionId }, "Session heartbeat failed")
    })
  }, HEARTBEAT_INTERVAL_MS)

  try {
    const result = await runEnclaveTurn({ keyPair: deps.keyPair, rawChat: deps.rawChat }, assignment)
    await deps.callbacks.complete(sessionId, result)
    logger.info({ sessionId, messages: result.messages.length }, "Enclave session completed")
  } catch (err) {
    // Nothing to ack — the backend reclaims the session when heartbeats stop.
    logger.error({ err, sessionId }, "Enclave session failed")
  } finally {
    clearInterval(heartbeat)
  }
}
