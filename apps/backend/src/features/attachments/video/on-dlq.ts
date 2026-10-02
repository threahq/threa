import { ProcessingStatuses } from "@threahq/types"
import type { OnDLQHook } from "../../../lib/queue"
import { OutboxRepository } from "../../../lib/outbox"
import { AttachmentRepository } from "../repository"
import { VideoTranscodeJobRepository } from "./job-repository"

export function createVideoTranscodeOnDLQ<T extends { workspaceId: string; attachmentId: string }>(
  failureMessage: string
): OnDLQHook<T> {
  return async (querier, job) => {
    await AttachmentRepository.updateProcessingStatus(
      querier,
      job.data.workspaceId,
      job.data.attachmentId,
      ProcessingStatuses.FAILED
    )
    const videoJob = await VideoTranscodeJobRepository.findByAttachmentId(
      querier,
      job.data.workspaceId,
      job.data.attachmentId
    )
    if (videoJob) {
      await VideoTranscodeJobRepository.updateFailed(querier, job.data.workspaceId, videoJob.id, failureMessage)
    }
    const att = await AttachmentRepository.findById(querier, job.data.workspaceId, job.data.attachmentId)
    await OutboxRepository.insert(querier, "attachment:transcoded", {
      workspaceId: job.data.workspaceId,
      ...(att?.streamId && { streamId: att.streamId }),
      ...(att?.messageId && { messageId: att.messageId }),
      attachmentId: job.data.attachmentId,
      processingStatus: ProcessingStatuses.FAILED,
    })
  }
}
