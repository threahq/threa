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
  /** Web-tool config for the turn loop (Tavily key). Absent → research/read_url only. */
  toolConfig?: { tavilyApiKey?: string }
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
    const result = await runEnclaveTurn(
      {
        keyPair: deps.keyPair,
        rawChat: deps.rawChat,
        // Stream each reply back as the loop sends it (delivered before the loop continues).
        onMessage: (reply) => deps.callbacks.message(sessionId, reply),
        // Stream each sealed trace step back as the loop emits it (live trace).
        onStep: (step) => deps.callbacks.step(sessionId, step),
        onSubstep: (substep) => deps.callbacks.substep(sessionId, substep),
        tools: deps.toolConfig ? { tavilyApiKey: deps.toolConfig.tavilyApiKey } : undefined,
      },
      assignment
    )
    await deps.callbacks.complete(sessionId, result)
    logger.info({ sessionId, messages: result.messageIds.length }, "Enclave session completed")
  } catch (err) {
    // This runs after the prompt/history were decrypted, so log only a scrubbed
    // classification — never the raw error object, which an upstream SDK might
    // populate with request/response content (the enclave never logs payloads).
    // Nothing to ack — the backend reclaims the session when heartbeats stop.
    const errorName = err instanceof Error ? err.name : typeof err
    logger.error({ errorName, sessionId }, "Enclave session failed")
  } finally {
    clearInterval(heartbeat)
  }
}
