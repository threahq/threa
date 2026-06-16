import type { VoiceTranscriptionService } from "./service"
import { logger } from "../../lib/logger"

export interface VoiceSessionSweeper {
  start(): void
  stop(): void
}

/**
 * Safety net for sessions left `active` past `expires_at`: the gateway's
 * in-process max-duration timer finalizes the common case, but a crash/restart
 * (or an HTTP-created session whose socket never connected) can strand rows that
 * would otherwise never reach a terminal status.
 */
export function createVoiceSessionSweeper(
  voiceTranscriptionService: VoiceTranscriptionService,
  options: { intervalMs?: number } = {}
): VoiceSessionSweeper {
  const { intervalMs = 60_000 } = options
  let timer: ReturnType<typeof setInterval> | null = null

  const sweep = async () => {
    try {
      const expired = await voiceTranscriptionService.expireStaleSessions()
      if (expired > 0) logger.info({ expired }, "Expired stale voice sessions")
    } catch (err) {
      logger.warn({ err }, "Voice session expiry sweep failed")
    }
  }

  return {
    start() {
      if (timer) return
      timer = setInterval(sweep, intervalMs)
      // Run once on boot to catch sessions stranded by the previous process.
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
