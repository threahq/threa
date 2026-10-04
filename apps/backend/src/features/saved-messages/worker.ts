import type { JobHandler, SavedReminderFireJobData } from "../../lib/queue"
import { logger } from "../../lib/logger"
import type { SavedMessagesService } from "./service"

/**
 * Worker handler for `saved.reminder_fire`. Delegates to the service's
 * idempotent `markReminderFired`; the worker itself holds no DB connection
 * across calls (INV-41). Jobs that find the row already done, archived, or
 * already-fired no-op quietly.
 */
export function createSavedReminderWorker(deps: {
  savedMessagesService: SavedMessagesService
}): JobHandler<SavedReminderFireJobData> {
  return async (job) => {
    const { savedMessageId, workspaceId, userId } = job.data

    const result = await deps.savedMessagesService.markReminderFired({ workspaceId, userId, savedId: savedMessageId })

    if (result.fired) {
      logger.info({ jobId: job.id, savedMessageId, workspaceId, userId }, "Saved reminder fired")
    } else {
      logger.debug(
        { jobId: job.id, savedMessageId, workspaceId, userId },
        "Saved reminder skipped (row missing, not saved, or already fired)"
      )
    }
  }
}
