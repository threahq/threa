import type { CallService } from "./service"
import { logger } from "../../lib/logger"
import { CALL_SWEEP_INTERVAL_MS } from "./config"
import { callSweepReapedTotal } from "../../lib/observability"

export interface CallSweeper {
  start(): void
  stop(): void
}

/**
 * Safety net for calls stranded by a crashed/restarted instance: persisted
 * leases and deadlines are the only durable liveness, so a periodic CAS sweep is
 * what turns a dead endpoint into a `left` participant and an emptied call into
 * an `ended` one (an in-memory timer dies with the instance and would wedge the
 * stream's active-call slot forever). Each stage is idempotent — a second sweep
 * matches nothing.
 */
export function createCallSweeper(callService: CallService, options: { intervalMs?: number } = {}): CallSweeper {
  const { intervalMs = CALL_SWEEP_INTERVAL_MS } = options
  let timer: ReturnType<typeof setInterval> | null = null

  const sweep = async () => {
    const now = new Date()
    try {
      // Order matters: reap lapsed endpoints and end graced calls BEFORE
      // expiring rings. An abandoned caller's lapsed endpoint and their 45s ring can
      // fall due in the same tick; reaping first cancels the ring (leave/grace
      // retracts it), so it never expires into a false missed call one statement
      // before the reap would have cancelled it.
      const endpoints = await callService.reapLapsedEndpoints(now)
      const calls = await callService.endGraceExpiredCalls(now)
      const rings = await callService.expireStaleRings(now)
      if (rings.expired > 0) callSweepReapedTotal.inc({ kind: "expired_ring" }, rings.expired)
      if (endpoints.endpoints > 0) callSweepReapedTotal.inc({ kind: "endpoint" }, endpoints.endpoints)
      if (endpoints.participants > 0) callSweepReapedTotal.inc({ kind: "participant" }, endpoints.participants)
      if (endpoints.calls > 0) callSweepReapedTotal.inc({ kind: "grace_call" }, endpoints.calls)
      if (rings.expired > 0 || endpoints.endpoints > 0 || calls.ended > 0) {
        logger.info(
          {
            expiredRings: rings.expired,
            reapedEndpoints: endpoints.endpoints,
            leftParticipants: endpoints.participants,
            gracedCalls: endpoints.calls,
            endedCalls: calls.ended,
          },
          "Call sweep"
        )
      }
    } catch (err) {
      logger.warn({ err }, "Call sweep failed")
    }
  }

  return {
    start() {
      if (timer) return
      timer = setInterval(sweep, intervalMs)
      void sweep()
    },

    stop() {
      if (timer) {
        clearInterval(timer)
        timer = null
      }
    },
  }
}
