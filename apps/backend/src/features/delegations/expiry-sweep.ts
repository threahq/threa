import { logger } from "../../lib/logger"
import { DELEGATION_EXPIRY_SWEEP_INTERVAL_MS } from "./config"
import type { DelegationService } from "./service"

export interface DelegationExpirySweep {
  start(): void
  stop(): void
}

/**
 * Periodic backstop for delegation claims whose holder went silent (roadmap
 * 5.1; same `setInterval` shape as `createOrphanSessionCleanup`). A local agent
 * that crashes or loses its network never completes/fails its claim — without
 * this the card would show "claimed" forever. The sweep CASes every lapsed
 * claim back to `open` and appends the card's status event in the same
 * transaction, so another executor can claim it.
 */
export function createDelegationExpirySweep(
  delegationService: DelegationService,
  options: { intervalMs?: number } = {}
): DelegationExpirySweep {
  const { intervalMs = DELEGATION_EXPIRY_SWEEP_INTERVAL_MS } = options

  let timer: ReturnType<typeof setInterval> | null = null

  const sweep = async () => {
    try {
      await delegationService.reopenLapsedClaims()
    } catch (err) {
      logger.error({ err }, "Error during delegation expiry sweep")
    }
  }

  return {
    start() {
      if (timer) return
      logger.info({ intervalMs }, "Starting delegation expiry sweep")
      timer = setInterval(sweep, intervalMs)
      // Run immediately on start to reopen claims that lapsed while the server was down.
      sweep()
    },

    stop() {
      if (timer) {
        clearInterval(timer)
        timer = null
        logger.info("Stopped delegation expiry sweep")
      }
    },
  }
}
