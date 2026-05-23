import type { VoiceTranscriptionService } from "./service"
import { logger } from "../../lib/logger"

export interface VoiceSessionSweeper {
  start(): void
  stop(): void
}

/**
 * Periodically expires voice sessions left `active` past their hard
 * `expires_at`. The gateway's in-process max-duration timer finalizes the
 * common case; this is the safety net for sessions a crash/restart (or an
 * HTTP-created session whose socket never connected) stranded active. Without
 * it those rows never reach a terminal status, holding a phantom "active"
 * dictation and skewing cost telemetry (PR3).
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
