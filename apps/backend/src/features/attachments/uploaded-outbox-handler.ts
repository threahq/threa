import type { Pool } from "pg"
import { isOutboxEventType } from "../../lib/outbox"
import { logger } from "../../lib/logger"
import { JobQueues } from "../../lib/queue"
import type { QueueManager } from "../../lib/queue"
import { DebouncedOutboxHandler, type DebouncedOutboxHandlerConfig, type OutboxEvent } from "../../lib/outbox"
import { isImageAttachment } from "./image-caption"
import { isPdfAttachment } from "./pdf"
import { isWordAttachment } from "./word"
import { isExcelAttachment } from "./excel"
import { isVideoAttachment } from "./video"

export type AttachmentUploadedHandlerConfig = DebouncedOutboxHandlerConfig

/**
 * Handler that processes attachment:uploaded events.
 *
 * For images: enqueues IMAGE_CAPTION job for AI processing
 * For PDFs: enqueues PDF_PREPARE job for document extraction
 * For others: enqueues TEXT_PROCESS job (binary detection decides skip vs process)
 */
export class AttachmentUploadedHandler extends DebouncedOutboxHandler {
  private readonly jobQueue: QueueManager

  constructor(db: Pool, jobQueue: QueueManager, config?: AttachmentUploadedHandlerConfig) {
    super(db, { listenerId: "attachment-uploaded", ...config })
    this.jobQueue = jobQueue
  }

  protected async processEvent(event: OutboxEvent): Promise<void> {
    if (!isOutboxEventType(event, "attachment:uploaded")) {
      return
    }

    const { attachmentId, workspaceId, filename, mimeType, storagePath } = event.payload

    switch (true) {
      case isImageAttachment(mimeType, filename):
        await this.jobQueue.send(JobQueues.IMAGE_CAPTION, {
          attachmentId,
          workspaceId,
          filename,
          mimeType,
          storagePath,
        })
        await this.jobQueue.send(JobQueues.IMAGE_THUMBNAIL, {
          attachmentId,
          workspaceId,
          filename,
          mimeType,
          storagePath,
        })
        logger.info({ attachmentId, filename, mimeType }, "Image caption + thumbnail jobs dispatched")
        break

      case isPdfAttachment(mimeType, filename):
        await this.jobQueue.send(JobQueues.PDF_PREPARE, {
          attachmentId,
          workspaceId,
          filename,
          storagePath,
        })
        logger.info({ attachmentId, filename, mimeType }, "PDF prepare job dispatched")
        break

      case isWordAttachment(mimeType, filename):
        await this.jobQueue.send(JobQueues.WORD_PROCESS, {
          attachmentId,
          workspaceId,
          filename,
          storagePath,
        })
        logger.info({ attachmentId, filename, mimeType }, "Word processing job dispatched")
        break

      case isExcelAttachment(mimeType, filename):
        await this.jobQueue.send(JobQueues.EXCEL_PROCESS, {
          attachmentId,
          workspaceId,
          filename,
          storagePath,
        })
        logger.info({ attachmentId, filename, mimeType }, "Excel processing job dispatched")
        break

      case isVideoAttachment(mimeType, filename):
        await this.jobQueue.send(JobQueues.VIDEO_TRANSCODE_SUBMIT, {
          attachmentId,
          workspaceId,
          filename,
          storagePath,
        })
        logger.info({ attachmentId, filename, mimeType }, "Video transcode submit job dispatched")
        break

      default:
        // Route everything else to text processing — binary detection decides skip vs process
        await this.jobQueue.send(JobQueues.TEXT_PROCESS, {
          attachmentId,
          workspaceId,
          filename,
          storagePath,
        })
        logger.info({ attachmentId, filename, mimeType }, "Text processing job dispatched")
    }
  }
}
