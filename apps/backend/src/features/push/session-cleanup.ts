import type { PushService } from "./service"
import { logger } from "../../lib/logger"
import { safeErrorCode } from "../../lib/errors"

export interface PushSessionCleanup {
  start(): void
  stop(): void
}

/**
 * Periodically deletes stale push user sessions, expired delivery ledger
 * rows and expired receipts to bound table growth. Database-only, so it runs
 * whether or not the provider can send: rows written before push was disabled
 * still reach their retention.
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
    try {
      const deleted = await pushService.cleanupExpiredDeliveries()
      if (deleted > 0) {
        logger.info({ deleted }, "Cleaned up expired push delivery plans")
      }
    } catch (err) {
      logger.warn({ errorCode: safeErrorCode(err) }, "Failed to clean up expired push delivery plans")
    }
    try {
      const deleted = await pushService.cleanupExpiredReceipts()
      if (deleted > 0) {
        logger.info({ deleted }, "Cleaned up expired push receipts")
      }
    } catch (err) {
      logger.warn({ errorCode: safeErrorCode(err) }, "Failed to clean up expired push receipts")
    }
  }

  return {
    start() {
      if (timer) return
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
