import type { PushService } from "./service"
import { logger } from "../../lib/logger"

export interface PushSessionCleanup {
  start(): void
  stop(): void
}

/**
 * Periodically deletes stale push user sessions to bound table growth.
 * Only runs when push is enabled — no sessions are written when disabled.
 */
export function createPushSessionCleanup(
  pushService: PushService,
  options: {
    intervalMs?: number
    maxAgeMs?: number
  } = {}
): PushSessionCleanup {
  // maxAgeMs matches the 30-day session cookie TTL so that session rows remain
  // available for the per-device push expiry check in PushService.
  const { intervalMs = 60 * 60 * 1000, maxAgeMs = 30 * 24 * 60 * 60 * 1000 } = options

  let timer: ReturnType<typeof setInterval> | null = null

  const cleanup = async () => {
    try {
      const deleted = await pushService.cleanupStaleSessions(maxAgeMs)
      if (deleted > 0) {
        logger.info({ deleted }, "Cleaned up stale push user sessions")
      }
    } catch (err) {
      logger.warn({ err }, "Failed to clean up stale push user sessions")
    }
  }

  return {
    start() {
      if (timer || !pushService.isEnabled()) return
      timer = setInterval(cleanup, intervalMs)
    },

    stop() {
      if (timer) {
        clearInterval(timer)
        timer = null
      }
    },
  }
}
