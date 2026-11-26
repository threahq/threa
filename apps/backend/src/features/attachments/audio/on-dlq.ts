import { ProcessingStatuses } from "@threahq/types"
import type { AudioProcessJobData, OnDLQHook } from "../../../lib/queue"
import { settleAudioWithoutResult } from "./service"

export function createAudioProcessOnDLQ(): OnDLQHook<AudioProcessJobData> {
  return async (querier, job) => {
    await settleAudioWithoutResult(querier, job.data.workspaceId, job.data.attachmentId, ProcessingStatuses.FAILED)
  }
}
