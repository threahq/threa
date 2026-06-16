import type { Pool } from "pg"
import { ProcessingStatuses } from "@threa/types"
import { AttachmentRepository } from "./repository"
import { logger } from "../../lib/logger"

export const DEFAULT_ATTACHMENT_PROCESSING_TIMEOUT_MS = 60_000

const POLL_INTERVAL_MS = 1_000

export interface AwaitAttachmentProcessingResult {
  allCompleted: boolean
  completedIds: string[]
  failedOrTimedOutIds: string[]
}

/**
 * Polls the database until all attachments reach a terminal state (completed, failed, skipped)
 * or the timeout is reached.
 */
export async function awaitAttachmentProcessing(
  pool: Pool,
  attachmentIds: string[],
  timeoutMs: number = DEFAULT_ATTACHMENT_PROCESSING_TIMEOUT_MS
): Promise<AwaitAttachmentProcessingResult> {
  if (attachmentIds.length === 0) {
    return { allCompleted: true, completedIds: [], failedOrTimedOutIds: [] }
  }

  const startTime = Date.now()
  const pendingIds = new Set(attachmentIds)
  const completedIds: string[] = []
  const failedIds: string[] = []

  logger.debug({ attachmentIds, timeoutMs }, "Starting to await attachment processing")

  // Each iteration auto-acquires and releases a connection via pool (not withClient).
  // This is intentional per INV-41: we release between polling intervals to avoid
  // holding connections during sleep. Do NOT wrap in withClient.
  while (pendingIds.size > 0 && Date.now() - startTime < timeoutMs) {
    const attachments = await AttachmentRepository.findByIds(pool, Array.from(pendingIds))

    for (const attachment of attachments) {
      if (attachment.processingStatus === ProcessingStatuses.COMPLETED) {
        pendingIds.delete(attachment.id)
        completedIds.push(attachment.id)
      } else if (
        attachment.processingStatus === ProcessingStatuses.FAILED ||
        attachment.processingStatus === ProcessingStatuses.SKIPPED
      ) {
        pendingIds.delete(attachment.id)
        failedIds.push(attachment.id)
      }
    }

    if (pendingIds.size === 0) {
      break
    }

    await sleep(POLL_INTERVAL_MS)
  }

  const timedOutIds = Array.from(pendingIds)
  const failedOrTimedOutIds = [...failedIds, ...timedOutIds]

  const result: AwaitAttachmentProcessingResult = {
    allCompleted: failedOrTimedOutIds.length === 0,
    completedIds,
    failedOrTimedOutIds,
  }

  if (timedOutIds.length > 0) {
    logger.warn(
      { timedOutIds, elapsedMs: Date.now() - startTime, timeoutMs },
      "Some attachments timed out waiting for processing"
    )
  }

  logger.debug(
    {
      allCompleted: result.allCompleted,
      completedCount: completedIds.length,
      failedCount: failedIds.length,
      timedOutCount: timedOutIds.length,
      elapsedMs: Date.now() - startTime,
    },
    "Finished awaiting attachment processing"
  )

  return result
}

/**
 * Check if any attachments in a list are still pending or processing.
 * Quick check without polling.
 */
export async function hasPendingAttachmentProcessing(pool: Pool, attachmentIds: string[]): Promise<boolean> {
  if (attachmentIds.length === 0) return false

  const attachments = await AttachmentRepository.findByIds(pool, attachmentIds)

  return attachments.some(
    (a) => a.processingStatus === ProcessingStatuses.PENDING || a.processingStatus === ProcessingStatuses.PROCESSING
  )
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
