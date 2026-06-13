import { logger as baseLogger } from "@threa/agent-runtime/logger"
import { INTERNAL_API_KEY_HEADER, type EnclaveSessionAssignment } from "@threa/types"
import type { EnclaveConfig } from "./config"
import type { EnclaveKeyPair } from "./keystore"
import { sessionAssignmentSchema } from "./assignment"

const logger = baseLogger.child({ name: "enclave-claim-loop" })

/**
 * The enclave's work intake (§2.7 pull transport): poll the backend's claim
 * endpoint and run whatever turn this instance's EIK wins. Nothing is pushed
 * to the enclave — it has no inbound content routes at all — so this loop is
 * the only way a turn starts here.
 *
 * Pacing: a winning claim polls again immediately (drain a backlog without
 * waiting out the interval); an empty poll (204) or an error waits
 * `claimPollIntervalMs`. Sessions run detached — the loop keeps claiming while
 * turns are in flight, up to `maxConcurrentSessions`; at that ceiling it stops
 * claiming until a turn settles, bounding per-box memory and OpenRouter spend.
 */

/** Claim responses carry the full assignment (inline attachment ciphertext can be tens of MB), so allow a slow transfer. */
const CLAIM_TIMEOUT_MS = 60_000

export interface ClaimLoop {
  stop: () => void
}

export interface ClaimLoopDeps {
  config: EnclaveConfig
  keyPair: EnclaveKeyPair
  /** Session ids currently running in this process — dedupes a re-served turn and feeds the shutdown drain. */
  inFlight: Set<string>
  /** Run one claimed turn (decrypt → loop → seal, reporting over the session callbacks). */
  runSession: (assignment: EnclaveSessionAssignment) => Promise<void>
}

/**
 * One poll: claim, and if a turn was won, start it detached and report
 * whether to poll again immediately. Exported for tests; production drives
 * it from `startClaimLoop`.
 */
export async function claimOnce(deps: ClaimLoopDeps): Promise<{ claimed: boolean }> {
  const { config, keyPair, inFlight, runSession } = deps

  // Per-instance ceiling. Turns run detached, so at capacity we stop claiming
  // rather than pile on — each in-flight turn pins its history + inline
  // attachment ciphertext (tens of MB) and burns OpenRouter spend. Reported as
  // "no work won" so the loop settles to the idle interval; a settling turn
  // frees the slot for the next poll. The loop serializes claimOnce, so this
  // check-then-add never overshoots the cap.
  if (inFlight.size >= config.maxConcurrentSessions) return { claimed: false }

  const res = await fetch(`${config.backendBaseUrl}/internal/enclave-runtimes/claims`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      [INTERNAL_API_KEY_HEADER]: config.internalApiKey,
    },
    body: JSON.stringify({ keyId: keyPair.keyId }),
    signal: AbortSignal.timeout(CLAIM_TIMEOUT_MS),
  })
  if (res.status === 204) return { claimed: false }
  if (res.status === 404) {
    // Our registry row was tombstoned (backend restarted faster than we
    // re-registered). The instance heartbeat re-registers on the same signal;
    // until then there's nothing to claim.
    logger.warn({ keyId: keyPair.keyId }, "Claim poll: runtime not registered; awaiting heartbeat re-registration")
    return { claimed: false }
  }
  if (res.status !== 200) {
    logger.warn({ status: res.status }, "Claim poll returned unexpected status")
    return { claimed: false }
  }

  const body = (await res.json()) as { assignment?: unknown }
  const parsed = sessionAssignmentSchema.safeParse(body.assignment)
  if (!parsed.success) {
    // The claim was consumed backend-side; its session will orphan and the
    // claim TTL recycles the turn. Loud, never silent (INV-11).
    logger.error({ issues: parsed.error.issues.slice(0, 5) }, "Claim poll returned an invalid assignment")
    return { claimed: false }
  }
  const assignment = parsed.data

  // A re-served turn for a session already running here — don't start a
  // second loop for it.
  if (inFlight.has(assignment.sessionId)) return { claimed: true }

  inFlight.add(assignment.sessionId)
  // Detached: the loop keeps polling while the turn runs; the runner reports
  // back over the session callbacks and its own failure path. The runner
  // handles its own errors — a rejection here is a bug, but it must still
  // release the in-flight slot and never take the process down.
  void runSession(assignment)
    .catch((err) => {
      const errorName = err instanceof Error ? err.name : typeof err
      logger.error({ errorName, sessionId: assignment.sessionId }, "Enclave session runner threw")
    })
    .finally(() => inFlight.delete(assignment.sessionId))
  return { claimed: true }
}

export function startClaimLoop(deps: ClaimLoopDeps): ClaimLoop {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null

  const tick = async () => {
    let claimed = false
    try {
      claimed = (await claimOnce(deps)).claimed
    } catch (err) {
      logger.warn({ err }, "Claim poll failed")
    }
    if (stopped) return
    // Drain after a win; otherwise settle back to the idle interval.
    timer = setTimeout(() => void tick(), claimed ? 0 : deps.config.claimPollIntervalMs)
  }

  logger.info({ intervalMs: deps.config.claimPollIntervalMs }, "Enclave claim loop started")
  void tick()

  return {
    stop: () => {
      stopped = true
      if (timer) clearTimeout(timer)
    },
  }
}
