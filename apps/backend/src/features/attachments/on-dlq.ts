import { ProcessingStatuses } from "@threahq/types"
import type { OnDLQHook } from "../../lib/queue"
import { AttachmentRepository } from "./repository"

export function createAttachmentFailedOnDLQ<T extends { workspaceId: string; attachmentId: string }>(): OnDLQHook<T> {
  return async (querier, job) => {
    await AttachmentRepository.updateProcessingStatus(
      querier,
      job.data.workspaceId,
      job.data.attachmentId,
      ProcessingStatuses.FAILED
    )
  }
}
