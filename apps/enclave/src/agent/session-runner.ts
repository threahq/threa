import { logger as baseLogger } from "@threa/agent-runtime/logger"
import type { EnclaveSessionAssignment } from "@threa/types"
import type { EnclaveKeyPair } from "../keystore"
import type { RawChatFn } from "../llm"
import type { BackendCallbacks } from "./backend-callbacks"
import { runEnclaveTurn } from "./run-turn"

const logger = baseLogger.child({ name: "enclave-session" })

/**
 * Refresh interval for the session heartbeat. The backend reclaims a session
 * whose heartbeat is older than ~60s, so this leaves many missed beats of
 * grace — and since the heartbeat response is also how a user's Stop reaches
 * the turn (§2.7: no inbound cancel route), the interval is the abort latency
 * ceiling, which wants to stay a few seconds, not fifteen.
 */
const HEARTBEAT_INTERVAL_MS = 5_000

export interface SessionRunnerDeps {
  keyPair: EnclaveKeyPair
  rawChat: RawChatFn
  callbacks: BackendCallbacks
  /** Web-tool config for the turn loop (Tavily key). Absent → research/read_url only. */
  toolConfig?: { tavilyApiKey?: string }
}

/**
 * Owns one claimed turn end to end: keeps the session's heartbeat fresh while
 * the agent loop runs (consuming the heartbeat's abort flag — a graceful user
 * Stop trips the turn's AbortController), then hands the sealed
 * replies back via `complete`. On failure it acks the backend via `fail` so
 * the session terminates promptly (orphan-cleanup stays the backstop if that
 * ack can't land). Plaintext lives only in `runEnclaveTurn`, for the duration
 * of the loop.
 */
export async function runEnclaveSession(deps: SessionRunnerDeps, assignment: EnclaveSessionAssignment): Promise<void> {
  const { sessionId } = assignment

  // The cancel channel: the heartbeat response says whether a user requested
  // an abort, and the controller feeds the turn's session-abort wiring
  // (runAbortSignal + all-tools toolSignalProvider) so the loop halts
  // gracefully — a committed reply so far, or none — whatever tool is active.
  const abortController = new AbortController()

  const heartbeat = setInterval(() => {
    void deps.callbacks
      .heartbeat(sessionId)
      .then(({ abort }) => {
        if (abort && !abortController.signal.aborted) {
          logger.info({ sessionId }, "Session abort requested via heartbeat")
          abortController.abort()
        }
      })
      .catch((err) => {
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
        // Open each in-flight step as the loop starts it, then finalize it on
        // completion — the same lifecycle the non-E2E runtime emits (live trace).
        onStepStarted: (step) => deps.callbacks.stepStarted(sessionId, step),
        onStep: (step) => deps.callbacks.step(sessionId, step),
        onSubstep: (substep) => deps.callbacks.substep(sessionId, substep),
        // Persist a sealed auto-title when the backend flagged this turn for it.
        onSealedName: (sealed) => deps.callbacks.sealedName(sessionId, sealed),
        // Persist the sealed rolling conversation summary when the window overflowed (C-2).
        onSealedSummary: (sealed) => deps.callbacks.sealedSummary(sessionId, sealed),
        // Mid-turn interjection (UX-12): let the loop pull the sealed messages
        // that land while it runs, so a follow-up reaches the turn in flight
        // rather than only via post-completion catch-up.
        pollNewMessages: (afterSequence) => deps.callbacks.pollMessages(sessionId, afterSequence),
        tools: deps.toolConfig ? { tavilyApiKey: deps.toolConfig.tavilyApiKey } : undefined,
        abortSignal: abortController.signal,
      },
      assignment
    )
    await deps.callbacks.complete(sessionId, result)
    logger.info({ sessionId, messages: result.messageIds.length }, "Enclave session completed")
  } catch (err) {
    // This runs after the prompt/history were decrypted, so derive only a scrubbed
    // classification — never the raw error object, which an upstream SDK might
    // populate with request/response content (the enclave never logs payloads).
    const errorName = err instanceof Error ? err.name : typeof err
    logger.error({ errorName, sessionId }, "Enclave session failed")
    // Stop liveness refresh now, before the (awaited) fail ack — otherwise a
    // hanging/slow `/fail` would keep beating `heartbeat_at` forward and push
    // back the orphan-cleanup backstop. (`finally` clears it again; idempotent.)
    clearInterval(heartbeat)
    // Ack the failure so the backend terminates the session now (clears the
    // inline indicator + open trace dialog) instead of waiting for orphan-cleanup.
    // Best-effort + scrubbed metadata only: if this can't land, heartbeats have
    // already stopped, so orphan-cleanup still reclaims the session as a backstop.
    await deps.callbacks.fail(sessionId, { errorName }).catch((failErr) => {
      const failErrorName = failErr instanceof Error ? failErr.name : typeof failErr
      logger.warn({ errorName: failErrorName, sessionId }, "Enclave session fail callback failed")
    })
  } finally {
    clearInterval(heartbeat)
  }
}
