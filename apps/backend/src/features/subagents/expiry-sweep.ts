import { logger } from "../../lib/logger"
import { SUBAGENT_EXPIRY_SWEEP_INTERVAL_MS } from "./config"
import type { SubagentService } from "./service"

export interface SubagentExpirySweep {
  start(): void
  stop(): void
}

/**
 * Periodic backstop for subagent runs nobody ever came back to. An active run
 * holds its parent stream's one live slot, so a conversation the user abandoned
 * would block every later delegation from that stream forever. The sweep CASes
 * every idle run to `expired` and appends the card's status patch in the same
 * transaction, so the card stops claiming someone is waiting on an answer.
 */
export function createSubagentExpirySweep(
  subagentService: SubagentService,
  options: { intervalMs?: number } = {}
): SubagentExpirySweep {
  const { intervalMs = SUBAGENT_EXPIRY_SWEEP_INTERVAL_MS } = options

  let timer: ReturnType<typeof setInterval> | null = null

  const sweep = async () => {
    try {
      await subagentService.expireIdleRuns()
    } catch (err) {
      logger.error({ err }, "Error during subagent expiry sweep")
    }
  }

  return {
    start() {
      if (timer) return
      logger.info({ intervalMs }, "Starting subagent expiry sweep")
      timer = setInterval(sweep, intervalMs)
      // Run immediately on start to expire runs that went idle while the server was down.
      sweep()
    },

    stop() {
      if (timer) {
        clearInterval(timer)
        timer = null
        logger.info("Stopped subagent expiry sweep")
      }
    },
  }
}
