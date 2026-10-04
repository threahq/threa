import type { Pool } from "pg"
import { AttachmentSafetyStatuses, StreamConnectionStates } from "@threahq/types"
import type { JobHandler, OnDLQHook, StreamConnectionCopyAttachmentJobData } from "../../lib/queue"
import { logger } from "../../lib/logger"
import type { StorageProvider } from "../../lib/storage/s3-client"
import { MAX_FILE_SIZE } from "../../middleware/upload"
import { AttachmentRepository, type AttachmentService } from "../attachments"
import type { BridgeClient } from "./bridge-client"
import { StreamConnectionRepository } from "./repository"

const DOWNLOAD_TIMEOUT_FLOOR_MS = 60_000
/** ~256 KB/s. A host transfer slower than this counts as stalled, so a large file gets a proportionally longer budget. */
const MIN_DOWNLOAD_BYTES_PER_MS = 256

interface Dependencies {
  pool: Pool
  bridgeClient: BridgeClient
  attachmentService: AttachmentService
  storage: StorageProvider
}

/**
 * Copies one host file into the partner's own storage. The bridge call and the
 * download run outside any transaction (INV-41); the row settles in a short one
 * afterwards. A host that has not finished with the file yet fails the job so
 * the queue retries it.
 */
export function createStreamConnectionCopyAttachmentWorker(
  deps: Dependencies
): JobHandler<StreamConnectionCopyAttachmentJobData> {
  return async (job) => {
    const { workspaceId, connectionId, attachmentId } = job.data
    const attachment = await AttachmentRepository.findById(deps.pool, workspaceId, attachmentId)
    if (attachment?.safetyStatus !== AttachmentSafetyStatuses.PENDING_UPLOAD) {
      logger.info({ ...job.data }, "Skipped a shared channel file copy: the file is not awaiting its bytes")
      return
    }
    const connection = await StreamConnectionRepository.findById(deps.pool, workspaceId, connectionId)
    if (
      connection?.role !== "partner" ||
      connection.state !== StreamConnectionStates.ACTIVE ||
      !connection.remoteWorkspaceId
    ) {
      logger.info({ ...job.data }, "Gave up a shared channel file copy: the connection is not an active partner")
      await deps.attachmentService.settleCopy(workspaceId, attachmentId, "failed")
      return
    }

    const answer = await deps.bridgeClient.getAttachment(
      { workspaceId: connection.remoteWorkspaceId, connectionId, callerWorkspaceId: workspaceId },
      attachmentId
    )
    switch (answer.status) {
      case "pending":
        throw new Error(`Host has not finished attachment ${attachmentId}`)
      case "blocked":
        await deps.attachmentService.settleCopy(workspaceId, attachmentId, "quarantined")
        return
      case "failed":
        await deps.attachmentService.settleCopy(workspaceId, attachmentId, "failed")
        return
      case "ready": {
        const bytes = await download(answer.url, attachment.sizeBytes)
        await deps.storage.putObject(attachment.storagePath, bytes, attachment.mimeType)
        await deps.attachmentService.settleCopy(workspaceId, attachmentId, "clean")
        return
      }
    }
  }
}

/** A copy that ran out of retries shows as failed rather than uploading forever. */
export function createStreamConnectionCopyAttachmentOnDLQ(deps: {
  attachmentService: AttachmentService
}): OnDLQHook<StreamConnectionCopyAttachmentJobData> {
  return async (querier, job) => {
    await deps.attachmentService.settleCopyInTransaction(querier, job.data.workspaceId, job.data.attachmentId, "failed")
  }
}

/** Reads the body, holding no more than the size the host's message declares and refusing any other length. */
async function download(url: string, sizeBytes: number): Promise<Buffer> {
  const limit = Math.min(sizeBytes, MAX_FILE_SIZE)
  const timeoutMs = DOWNLOAD_TIMEOUT_FLOOR_MS + Math.ceil(limit / MIN_DOWNLOAD_BYTES_PER_MS)
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error(`Host storage answered ${res.status}`)
  const tooLarge = new Error(`Host file is larger than the ${limit} bytes its message declares`)
  if (Number(res.headers.get("content-length") ?? 0) > limit) throw tooLarge
  const body = res.body as unknown as AsyncIterable<Uint8Array> | null
  const chunks: Uint8Array[] = []
  let received = 0
  for await (const chunk of body ?? []) {
    received += chunk.byteLength
    if (received > limit) throw tooLarge
    chunks.push(chunk)
  }
  if (received !== sizeBytes)
    throw new Error(`Host file is ${received} bytes, not the ${sizeBytes} its message declares`)
  return Buffer.concat(chunks)
}
