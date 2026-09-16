import { logger } from "../../lib/logger"
import { DECISION_EXPIRY_SWEEP_INTERVAL_MS } from "./config"
import type { DecisionService } from "./service"

export interface DecisionExpirySweep {
  start(): void
  stop(): void
}

/**
 * Turns a decision's deadline into a real transition. Nothing else moves an
 * unanswered card: without this it would sit open forever and the runtime that
 * asked would never learn its question lapsed.
 */
export function createDecisionExpirySweep(
  decisionService: DecisionService,
  options: { intervalMs?: number } = {}
): DecisionExpirySweep {
  const { intervalMs = DECISION_EXPIRY_SWEEP_INTERVAL_MS } = options

  let timer: ReturnType<typeof setInterval> | null = null

  const sweep = async () => {
    try {
      await decisionService.expireDue()
    } catch (err) {
      logger.error({ err }, "Error during decision expiry sweep")
    }
  }

  return {
    start() {
      if (timer) return
      logger.info({ intervalMs }, "Starting decision expiry sweep")
      timer = setInterval(sweep, intervalMs)
      // Run immediately on start to expire decisions that lapsed while the server was down.
      sweep()
    },

    stop() {
      if (timer) {
        clearInterval(timer)
        timer = null
        logger.info("Stopped decision expiry sweep")
      }
    },
  }
}
