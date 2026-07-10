import type { AttachmentUploadSweepJobData, JobHandler } from "../../lib/queue"
import type { AttachmentService } from "./service"

export interface AttachmentUploadSweepWorkerDeps {
  attachmentService: AttachmentService
}

/**
 * Cron-driven safety net for reserved uploads whose client died without
 * reporting failure (tab killed mid-transfer, device offline forever). The
 * client reports terminal failures itself; this sweep only catches the ones
 * nobody could report. Thresholds and the transition rules live in
 * `AttachmentService.sweepStaleUploads`.
 */
export function createAttachmentUploadSweepWorker(
  deps: AttachmentUploadSweepWorkerDeps
): JobHandler<AttachmentUploadSweepJobData> {
  return async () => {
    await deps.attachmentService.sweepStaleUploads()
  }
}
