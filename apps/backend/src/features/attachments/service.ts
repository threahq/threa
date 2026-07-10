import { z } from "zod"
import { Pool, type PoolClient } from "pg"
import { withTransaction } from "../../db"
import { OutboxRepository } from "../../lib/outbox"
import { AttachmentRepository, type Attachment } from "./repository"
import { AttachmentUploadRepository } from "./upload-repository"
import { AttachmentReferenceRepository } from "./reference-repository"
import { AttachmentExtractionRepository } from "./extraction-repository"
import type { StorageProvider } from "../../lib/storage/s3-client"
import { AttachmentSafetyStatuses, AttachmentUploadStatuses, ProcessingStatuses } from "@threa/types"
import { isAttachmentSafeForSharing, safetyStatusBlockReason, type MalwareScanner } from "./upload-safety-policy"
import { logger } from "../../lib/logger"
import { attachmentUploadId } from "../../lib/id"

/**
 * Builds a Content-Disposition header value with both ASCII fallback and
 * RFC 5987 filename* parameter for non-ASCII filenames.
 */
export function buildContentDisposition(filename: string): string {
  const asciiFallback = filename.replace(/[^\x20-\x7E]/g, "_").replace(/"/g, '\\"')
  // RFC 5987 filename* parameter, percent-encoded per UTF-8.
  const encoded = encodeURIComponent(filename).replace(/'/g, "%27")
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`
}

const STALE_PENDING_SCAN_THRESHOLD_MS = 5 * 60 * 1000
const STALE_PENDING_SCAN_BATCH_SIZE = 200

export interface CreateAttachmentParams {
  id: string
  workspaceId: string
  uploadedBy: string
  filename: string
  mimeType: string
  sizeBytes: number
  storagePath: string
  /**
   * The bytes in S3 are client-side ciphertext. Skips the malware scan (it can't
   * read ciphertext) and emits no processor work; the row is marked
   * `e2e_unscanned` + `skipped`. Caller passes placeholder filename/mime.
   */
  e2e?: boolean
}

/** Server-forced metadata for E2E uploads — the real values ride encrypted. */
export const E2E_PLACEHOLDER_FILENAME = "encrypted"
export const E2E_PLACEHOLDER_MIME_TYPE = "application/octet-stream"

/** The raw facts an upload entry point knows after multer streams a file to S3. */
export interface UploadedFileFacts {
  id: string
  workspaceId: string
  uploadedBy: string
  filename: string
  mimeType: string
  sizeBytes: number
  storagePath: string
}

/**
 * Derive the create params from an uploaded file and the caller's E2E intent —
 * the single chokepoint every upload entry point (first-party + public API)
 * routes through, so the threat-model rule "E2E ⇒ the server keeps no real
 * filename/mime" can't drift between them. For E2E we overwrite the client's
 * metadata with placeholders by construction; the real values ride encrypted in
 * the message's attachmentRefs.
 */
export function buildUploadParams(file: UploadedFileFacts, e2e: boolean): CreateAttachmentParams {
  return {
    ...file,
    filename: e2e ? E2E_PLACEHOLDER_FILENAME : file.filename,
    mimeType: e2e ? E2E_PLACEHOLDER_MIME_TYPE : file.mimeType,
    e2e,
  }
}

/**
 * Parse the multipart `e2e` flag. Form fields arrive as the string `"true"`;
 * JSON callers may send a real boolean. Anything else (absent/other) is false.
 */
const e2eUploadFlagSchema = z
  .object({ e2e: z.union([z.literal("true"), z.boolean()]).optional() })
  .transform((body) => body.e2e === "true" || body.e2e === true)

export function parseE2eUploadFlag(body: unknown): boolean {
  const parsed = e2eUploadFlagSchema.safeParse(body)
  return parsed.success ? parsed.data : false
}

export type CreateAttachmentForUploadResult =
  | { status: "created"; attachment: Attachment }
  | { status: "blocked"; reason: string }
  | { status: "cleanup_failed"; attachmentId: string }

export interface ReserveAttachmentParams {
  id: string
  workspaceId: string
  uploadedBy: string
  filename: string
  mimeType: string
  sizeBytes: number
  clientMessageId?: string | null
  draftId?: string | null
  e2e?: boolean
}

export class AttachmentService {
  constructor(
    private pool: Pool,
    private storage: StorageProvider,
    private malwareScanner: MalwareScanner
  ) {}

  async reserve(params: ReserveAttachmentParams): Promise<Attachment> {
    const storagePath = `${params.workspaceId}/${params.id}/${params.e2e ? E2E_PLACEHOLDER_FILENAME : params.filename}`
    return withTransaction(this.pool, async (client) => {
      const attachment = await AttachmentRepository.insert(client, {
        id: params.id,
        workspaceId: params.workspaceId,
        uploadedBy: params.uploadedBy,
        filename: params.e2e ? E2E_PLACEHOLDER_FILENAME : params.filename,
        mimeType: params.e2e ? E2E_PLACEHOLDER_MIME_TYPE : params.mimeType,
        sizeBytes: params.sizeBytes,
        storagePath,
        safetyStatus: AttachmentSafetyStatuses.PENDING_UPLOAD,
        processingStatus: ProcessingStatuses.PENDING,
        e2eOnly: params.e2e === true,
      })
      await AttachmentUploadRepository.insert(client, {
        id: attachmentUploadId(),
        workspaceId: params.workspaceId,
        attachmentId: params.id,
        uploadedBy: params.uploadedBy,
        clientMessageId: params.clientMessageId ?? null,
        draftId: params.draftId ?? null,
        expectedSizeBytes: params.sizeBytes,
      })
      return attachment
    })
  }

  async completeReservedUpload(params: CreateAttachmentParams): Promise<CreateAttachmentForUploadResult> {
    const upload = await AttachmentUploadRepository.findByAttachmentId(this.pool, params.id)
    if (!upload) {
      // The reserved-content route validates the reservation before the S3
      // middleware runs; reaching here without one is a wiring bug, not a
      // legacy upload — fail loudly rather than minting a row for an
      // unreserved id (INV-11).
      throw new Error(`No upload reservation found for attachment ${params.id}`)
    }
    if (upload.workspaceId !== params.workspaceId || upload.uploadedBy !== params.uploadedBy) {
      throw new Error("Attachment upload reservation does not belong to this user/workspace")
    }
    const reserved = await AttachmentRepository.findById(this.pool, params.id)
    if (!reserved) throw new Error(`Attachment row missing for reservation ${params.id}`)
    // The e2e-ness of an attachment is fixed at reserve time. Trusting a
    // request-supplied flag here would let a plaintext reservation complete as
    // `e2e_unscanned` (shareable) and skip the malware scan entirely.
    if (params.e2e !== reserved.e2eOnly) {
      throw new Error(`Attachment ${params.id} e2e flag does not match its reservation`)
    }
    // params.sizeBytes is the byte count multer actually streamed, so this is
    // the enforcement point for the reservation's declared size — the upload
    // middleware only applies the global cap.
    if (params.sizeBytes !== upload.expectedSizeBytes) {
      throw new Error(
        `Attachment ${params.id} uploaded size ${params.sizeBytes} does not match reserved size ${upload.expectedSizeBytes}`
      )
    }

    if (params.e2e) {
      const attachment = await withTransaction(this.pool, async (client) => {
        const upload = await AttachmentUploadRepository.markUploaded(client, params.id, params.sizeBytes)
        if (!upload) throw new Error(`Attachment upload ${params.id} is not in a completable state`)
        const safetyUpdated = await AttachmentRepository.updateSafetyStatus(
          client,
          params.id,
          AttachmentSafetyStatuses.E2E_UNSCANNED,
          { onlyIfStatus: AttachmentSafetyStatuses.PENDING_UPLOAD }
        )
        if (!safetyUpdated) {
          const current = await AttachmentRepository.findById(client, params.id)
          if (!current) throw new Error(`Attachment not found after upload completion: ${params.id}`)
          if (current.safetyStatus !== AttachmentSafetyStatuses.E2E_UNSCANNED) {
            throw new Error(`Attachment ${params.id} safety status transition rejected from ${current.safetyStatus}`)
          }
        }
        await AttachmentRepository.updateProcessingStatus(client, params.id, ProcessingStatuses.SKIPPED)
        const updated = await AttachmentRepository.findById(client, params.id)
        if (!updated) throw new Error(`Attachment not found after upload completion: ${params.id}`)
        await this.publishUploadCompleted(client, updated)
        return updated
      })
      return { status: "created", attachment }
    }

    await withTransaction(this.pool, async (client) => {
      const upload = await AttachmentUploadRepository.markUploaded(client, params.id, params.sizeBytes)
      if (!upload) throw new Error(`Attachment upload ${params.id} is not in a completable state`)
      const updated = await AttachmentRepository.updateSafetyStatus(
        client,
        params.id,
        AttachmentSafetyStatuses.PENDING_SCAN,
        { onlyIfStatus: AttachmentSafetyStatuses.PENDING_UPLOAD }
      )
      if (!updated) {
        const current = await AttachmentRepository.findById(client, params.id)
        if (!current) throw new Error(`Attachment not found after upload completion: ${params.id}`)
        if (current.safetyStatus !== AttachmentSafetyStatuses.PENDING_SCAN) {
          throw new Error(`Attachment ${params.id} safety status transition rejected from ${current.safetyStatus}`)
        }
      }
    })

    const scanResult = await this.malwareScanner.scan({
      storagePath: params.storagePath,
      filename: params.filename,
      mimeType: params.mimeType,
    })

    const attachment = await withTransaction(this.pool, async (client) => {
      const safetyUpdated = await AttachmentRepository.updateSafetyStatus(client, params.id, scanResult.status, {
        onlyIfStatus: AttachmentSafetyStatuses.PENDING_SCAN,
      })
      if (!safetyUpdated) {
        const current = await AttachmentRepository.findById(client, params.id)
        if (!current) throw new Error(`Attachment ${params.id} was deleted before safety status could be updated`)
        throw new Error(`Attachment ${params.id} safety status transition rejected from ${current.safetyStatus}`)
      }
      if (scanResult.status === AttachmentSafetyStatuses.CLEAN) {
        await OutboxRepository.insert(client, "attachment:uploaded", {
          workspaceId: params.workspaceId,
          attachmentId: params.id,
          filename: params.filename,
          mimeType: params.mimeType,
          sizeBytes: params.sizeBytes,
          storagePath: params.storagePath,
        })
      } else {
        await AttachmentRepository.updateProcessingStatus(client, params.id, ProcessingStatuses.SKIPPED)
      }
      const updated = await AttachmentRepository.findById(client, params.id)
      if (!updated) throw new Error(`Attachment not found after safety update: ${params.id}`)
      await this.publishUploadCompleted(client, updated)
      return updated
    })

    const blockReason = this.getSharingBlockReason(attachment)
    if (!blockReason) return { status: "created", attachment }
    return { status: "blocked", reason: blockReason }
  }

  /**
   * Tell clients a reserved upload's safety settled. A message can bind the
   * attachment while bytes are still uploading, and stored message content is
   * never revisited — this event is what flips the timeline chip from
   * "uploading" to ready (or blocked) after the fact, mirroring
   * `attachment:transcoded` for video processing.
   */
  private async publishUploadCompleted(client: PoolClient, attachment: Attachment): Promise<void> {
    await OutboxRepository.insert(client, "attachment:upload_completed", {
      workspaceId: attachment.workspaceId,
      ...(attachment.streamId && { streamId: attachment.streamId }),
      ...(attachment.messageId && { messageId: attachment.messageId }),
      attachmentId: attachment.id,
      uploadStatus: AttachmentUploadStatuses.UPLOADED,
      safetyStatus: attachment.safetyStatus,
    })
  }

  /**
   * Records attachment metadata after file has been uploaded to S3.
   * The upload itself is handled by multer-s3 middleware (streaming, no temp files).
   * File is uploaded to workspace-level; streamId is set when attached to a message.
   * Malware scan runs before attachment processing workers are dispatched.
   */
  async create(params: CreateAttachmentParams): Promise<Attachment> {
    const sizeBytes =
      Number.isFinite(params.sizeBytes) && params.sizeBytes > 0
        ? params.sizeBytes
        : await this.storage.getObjectSize(params.storagePath)

    // E2E: the bytes are ciphertext the scanner can't read and processors can't
    // parse. Insert as unscanned + skipped and emit no `attachment:uploaded`
    // event — no caption/extract/transcode/embedding work is dispatched.
    if (params.e2e) {
      return withTransaction(this.pool, async (client) =>
        AttachmentRepository.insert(client, {
          id: params.id,
          workspaceId: params.workspaceId,
          uploadedBy: params.uploadedBy,
          // Force placeholders at the persistence boundary too, not only in
          // buildUploadParams — the threat-model rule "server keeps no real
          // filename/mime for E2E" then holds even for a caller that reaches
          // create() without going through that helper.
          filename: E2E_PLACEHOLDER_FILENAME,
          mimeType: E2E_PLACEHOLDER_MIME_TYPE,
          sizeBytes,
          storagePath: params.storagePath,
          safetyStatus: AttachmentSafetyStatuses.E2E_UNSCANNED,
          processingStatus: ProcessingStatuses.SKIPPED,
          e2eOnly: true,
        })
      )
    }

    const attachment = await withTransaction(this.pool, async (client) => {
      return AttachmentRepository.insert(client, {
        id: params.id,
        workspaceId: params.workspaceId,
        uploadedBy: params.uploadedBy,
        filename: params.filename,
        mimeType: params.mimeType,
        sizeBytes,
        storagePath: params.storagePath,
        safetyStatus: AttachmentSafetyStatuses.PENDING_SCAN,
      })
    })

    const scanResult = await this.malwareScanner.scan({
      storagePath: params.storagePath,
      filename: params.filename,
      mimeType: params.mimeType,
    })

    return withTransaction(this.pool, async (client) => {
      const safetyUpdated = await AttachmentRepository.updateSafetyStatus(client, params.id, scanResult.status, {
        onlyIfStatus: AttachmentSafetyStatuses.PENDING_SCAN,
      })
      if (!safetyUpdated) {
        const current = await AttachmentRepository.findById(client, params.id)
        if (!current) {
          throw new Error(`Attachment ${params.id} was deleted before safety status could be updated`)
        }
        throw new Error(
          `Attachment ${params.id} safety status transition rejected from ${current.safetyStatus} to ${scanResult.status}`
        )
      }

      if (scanResult.status === AttachmentSafetyStatuses.CLEAN) {
        // Emit outbox event for workers only after malware scan is clean.
        await OutboxRepository.insert(client, "attachment:uploaded", {
          workspaceId: params.workspaceId,
          attachmentId: params.id,
          filename: params.filename,
          mimeType: params.mimeType,
          sizeBytes,
          storagePath: params.storagePath,
        })
      } else {
        await AttachmentRepository.updateProcessingStatus(client, params.id, ProcessingStatuses.SKIPPED)
        logger.warn(
          {
            attachmentId: params.id,
            filename: params.filename,
            mimeType: params.mimeType,
            reason: scanResult.reason ?? "unknown",
          },
          "Attachment quarantined by malware scanner"
        )
      }

      const updated = await AttachmentRepository.findById(client, attachment.id)
      if (!updated) {
        throw new Error(`Attachment not found after safety update: ${attachment.id}`)
      }
      return updated
    })
  }

  /**
   * Creates an attachment for upload response flows.
   * Unsafe attachments are cleaned up immediately and return a blocked result.
   */
  async createForUpload(params: CreateAttachmentParams): Promise<CreateAttachmentForUploadResult> {
    const attachment = await this.create(params)
    const blockReason = this.getSharingBlockReason(attachment)

    if (!blockReason) {
      return { status: "created", attachment }
    }

    try {
      const deleted = await this.delete(attachment.id)
      if (!deleted) {
        logger.error({ attachmentId: attachment.id }, "Quarantined attachment cleanup did not delete attachment")
        return { status: "cleanup_failed", attachmentId: attachment.id }
      }
    } catch (err) {
      logger.error({ err, attachmentId: attachment.id }, "Failed to clean up quarantined upload")
      return { status: "cleanup_failed", attachmentId: attachment.id }
    }

    return { status: "blocked", reason: blockReason }
  }

  getSharingBlockReason(attachment: Attachment): string | null {
    if (isAttachmentSafeForSharing(attachment.safetyStatus)) {
      return null
    }
    return safetyStatusBlockReason(attachment.safetyStatus)
  }

  async getById(id: string): Promise<Attachment | null> {
    return AttachmentRepository.findById(this.pool, id)
  }

  /**
   * Fetch an attachment and enforce workspace, stream-access, and sharing-safety
   * boundaries in one call. Returns null when any check fails so callers never
   * need to replicate the access-control logic inline.
   *
   * Stream-access check is satisfied either by the attachment's owning stream
   * being in `accessibleStreamIds`, or by an `attachment_references` row that
   * points at any accessible stream — keeping this consistent with the
   * `getDownloadUrl` chain so agent tools and public-api handlers honour
   * resends/Ariadne re-surfacings.
   */
  async getAccessible(
    id: string,
    { workspaceId, accessibleStreamIds }: { workspaceId: string; accessibleStreamIds: string[] }
  ): Promise<Attachment | null> {
    const attachment = await AttachmentRepository.findById(this.pool, id)
    if (!attachment || attachment.workspaceId !== workspaceId) {
      return null
    }
    const accessibleSet = new Set(accessibleStreamIds)
    let directlyAccessible = !!attachment.streamId && accessibleSet.has(attachment.streamId)
    if (!directlyAccessible) {
      const refStreamIds = await AttachmentReferenceRepository.findReferencingStreamIds(this.pool, workspaceId, id)
      directlyAccessible = refStreamIds.some((streamId) => accessibleSet.has(streamId))
    }
    if (!directlyAccessible) {
      return null
    }
    if (this.getSharingBlockReason(attachment)) {
      return null
    }
    return attachment
  }

  async getByIds(ids: string[]): Promise<Attachment[]> {
    return AttachmentRepository.findByIds(this.pool, ids)
  }

  async getByMessageId(messageId: string): Promise<Attachment[]> {
    return AttachmentRepository.findByMessageId(this.pool, messageId)
  }

  async getByMessageIds(messageIds: string[]): Promise<Map<string, Attachment[]>> {
    return AttachmentRepository.findByMessageIds(this.pool, messageIds)
  }

  async getDownloadUrl(attachment: Attachment, options?: { download?: boolean }): Promise<string> {
    const responseContentDisposition = options?.download ? buildContentDisposition(attachment.filename) : undefined
    return this.storage.getSignedDownloadUrl(attachment.storagePath, { responseContentDisposition })
  }

  async delete(id: string): Promise<boolean> {
    const storagePath = await withTransaction(this.pool, async (client) => {
      const attachment = await AttachmentRepository.findByIdForUpdate(client, id)
      if (!attachment) {
        return null
      }

      await AttachmentExtractionRepository.deleteByAttachmentId(client, id)
      await AttachmentUploadRepository.deleteByAttachmentId(client, id)
      const deleted = await AttachmentRepository.delete(client, id)
      if (!deleted) {
        throw new Error(`Attachment ${id} could not be deleted after row lock`)
      }

      return attachment.storagePath
    })

    if (!storagePath) {
      return false
    }

    await this.storage.delete(storagePath)
    return true
  }

  async recoverStalePendingScans(options?: { staleThresholdMs?: number; batchSize?: number }): Promise<number> {
    const staleThresholdMs = options?.staleThresholdMs ?? STALE_PENDING_SCAN_THRESHOLD_MS
    const batchSize = options?.batchSize ?? STALE_PENDING_SCAN_BATCH_SIZE

    if (staleThresholdMs <= 0) {
      throw new Error(`staleThresholdMs must be positive, got ${staleThresholdMs}`)
    }

    if (batchSize <= 0) {
      throw new Error(`batchSize must be positive, got ${batchSize}`)
    }

    const olderThan = new Date(Date.now() - staleThresholdMs)
    const recoveredIds = await withTransaction(this.pool, (client) =>
      AttachmentRepository.quarantineStalePendingScans(client, {
        olderThan,
        limit: batchSize,
      })
    )

    if (recoveredIds.length > 0) {
      logger.warn(
        {
          count: recoveredIds.length,
          attachmentIds: recoveredIds,
          staleThresholdMs,
        },
        "Recovered stale pending malware scans by quarantining attachments"
      )
    }

    return recoveredIds.length
  }
}
