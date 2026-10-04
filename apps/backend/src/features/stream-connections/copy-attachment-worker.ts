import type { Pool } from "pg"
import { AttachmentSafetyStatuses, StreamConnectionStates } from "@threahq/types"
import type { JobHandler, OnDLQHook, StreamConnectionCopyAttachmentJobData } from "../../lib/queue"
import { logger } from "../../lib/logger"
import type { StorageProvider } from "../../lib/storage/s3-client"
import { MAX_FILE_SIZE } from "../../middleware/upload"
import { AttachmentRepository, type AttachmentService } from "../attachments"
import type { BridgeClient } from "./bridge-client"
import { StreamConnectionRepository } from "./repository"

const DOWNLOAD_TIMEOUT_MS = 60_000

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
      logger.info({ ...job.data }, "Skipped a shared channel file copy: the connection is not an active partner")
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
      case "ready": {
        const bytes = await download(answer.url, Math.min(attachment.sizeBytes, MAX_FILE_SIZE))
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

/** Reads the body, refusing to hold more than `limit` bytes however the host declares its size. */
async function download(url: string, limit: number): Promise<Buffer> {
  const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
  if (!res.ok) throw new Error(`Host storage answered ${res.status}`)
  if (Number(res.headers.get("content-length") ?? 0) > limit) {
    throw new Error(`Host file is larger than the ${limit} bytes its message declares`)
  }
  const body = res.body as unknown as AsyncIterable<Uint8Array> | null
  const chunks: Uint8Array[] = []
  let received = 0
  for await (const chunk of body ?? []) {
    received += chunk.byteLength
    if (received > limit) throw new Error(`Host file is larger than the ${limit} bytes its message declares`)
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}
