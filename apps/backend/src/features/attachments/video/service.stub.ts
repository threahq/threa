import type { Pool } from "pg"
import { withTransaction } from "../../../db"
import { AttachmentRepository } from "../repository"
import { OutboxRepository } from "../../../lib/outbox"
import { ProcessingStatuses } from "@threahq/types"
import { logger } from "../../../lib/logger"
import type { VideoTranscodingServiceLike } from "./service"

/**
 * Stub video transcoding service for dev/test environments.
 * Immediately marks attachments as SKIPPED since MediaConvert is not available.
 */
export class StubVideoTranscodingService implements VideoTranscodingServiceLike {
  constructor(private readonly pool: Pool) {}

  async submit(attachmentId: string): Promise<void> {
    logger.info({ attachmentId }, "Stub video transcode: skipping (MediaConvert disabled)")
    await withTransaction(this.pool, async (client) => {
      await AttachmentRepository.updateProcessingStatus(client, attachmentId, ProcessingStatuses.SKIPPED)
      const att = await AttachmentRepository.findById(client, attachmentId)
      await OutboxRepository.insert(client, "attachment:transcoded", {
        workspaceId: att?.workspaceId ?? "",
        ...(att?.streamId && { streamId: att.streamId }),
        ...(att?.messageId && { messageId: att.messageId }),
        attachmentId,
        processingStatus: ProcessingStatuses.SKIPPED,
      })
    })
  }

  async checkStatus(_attachmentId: string): Promise<boolean> {
    return true
  }
}
