import { z } from "zod"
import { Pool, type PoolClient } from "pg"
import { withTransaction } from "../../db"
import { OutboxRepository } from "../../lib/outbox"
import { AttachmentRepository, type Attachment } from "./repository"
import { AttachmentUploadRepository } from "./upload-repository"
import { AttachmentReferenceRepository } from "./reference-repository"
import { AttachmentExtractionRepository } from "./extraction-repository"
import type { StorageProvider } from "../../lib/storage/s3-client"
import {
  AttachmentSafetyStatuses,
  AttachmentUploadStatuses,
  ProcessingStatuses,
  type AttachmentSafetyStatus,
  type AttachmentUploadStatus,
} from "@threa/types"
import { isAttachmentSafeForSharing, safetyStatusBlockReason, type MalwareScanner } from "./upload-safety-policy"
import { attachmentUploadId } from "../../lib/id"
import { logger } from "../../lib/logger"

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
  e2e: boolean
}

export type CompleteReservedUploadResult =
  | { status: "created"; attachment: Attachment }
  | { status: "blocked"; reason: string }
  | { status: "size_mismatch"; expectedSizeBytes: number; receivedSizeBytes: number }
  | { status: "conflict"; reason: string }

export type ReportUploadFailureResult = "reported" | "already_settled" | "not_found" | "forbidden"

/** Reserved/uploading rows idle this long flip to `failed` (dead client). */
const STALE_UPLOAD_FAIL_AFTER_MS = 4 * 60 * 60 * 1000
/** Failed rows idle this long flip to `abandoned`; unbound ones are deleted. */
const STALE_UPLOAD_ABANDON_AFTER_MS = 7 * 24 * 60 * 60 * 1000
const STALE_UPLOAD_SWEEP_BATCH_SIZE = 200

export class AttachmentService {
  constructor(
    private pool: Pool,
    private storage: StorageProvider,
    private malwareScanner: MalwareScanner
  ) {}

  /**
   * Create the attachment row BEFORE its bytes exist so the id can bind to a
   * message while the upload continues (send-while-uploading). The row is
   * `pending_upload` — bindable by its uploader, never downloadable — and an
   * `attachment_uploads` tracking row (INV-57) carries the transient workflow
   * state until the upload settles.
   */
  async reserve(params: ReserveAttachmentParams): Promise<Attachment> {
    const filename = params.e2e ? E2E_PLACEHOLDER_FILENAME : params.filename
    const storagePath = `${params.workspaceId}/${params.id}/${filename}`
    return withTransaction(this.pool, async (client) => {
      const attachment = await AttachmentRepository.insert(client, {
        id: params.id,
        workspaceId: params.workspaceId,
        uploadedBy: params.uploadedBy,
        filename,
        mimeType: params.e2e ? E2E_PLACEHOLDER_MIME_TYPE : params.mimeType,
        sizeBytes: params.sizeBytes,
        storagePath,
        safetyStatus: AttachmentSafetyStatuses.PENDING_UPLOAD,
        e2eOnly: params.e2e,
      })
      await AttachmentUploadRepository.insert(client, {
        id: attachmentUploadId(),
        workspaceId: params.workspaceId,
        attachmentId: params.id,
        uploadedBy: params.uploadedBy,
        expectedSizeBytes: params.sizeBytes,
      })
      return attachment
    })
  }

  /**
   * Settle a reserved upload after multer streamed the bytes to the reserved
   * storage path. Runs the malware scan (E2E ciphertext skips it), flips
   * `safety_status` off `pending_upload`, deletes the tracking row on success,
   * and — when the attachment is already bound to a message — emits
   * `attachment:upload_status_changed` so every viewer's chip settles.
   *
   * The route's validation middleware already checked ownership/state before
   * any byte reached S3; reaching here without a tracking row means either a
   * wiring bug or a concurrent duplicate completion (two tabs resuming the
   * same persisted job) whose winner already settled — the latter is treated
   * as idempotent success.
   */
  async completeReservedUpload(params: { attachment: Attachment }): Promise<CompleteReservedUploadResult> {
    const { attachment } = params
    const upload = await AttachmentUploadRepository.findByAttachmentId(this.pool, attachment.workspaceId, attachment.id)
    if (!upload) {
      const settled = await this.settledDuplicate(attachment.id)
      if (settled) return { status: "created", attachment: settled }
      throw new Error(`No upload reservation found for attachment ${attachment.id}`)
    }

    // What actually landed, from a HeadObject on the stored object. Multer's
    // reported size can NOT be trusted here: for bodies large enough that
    // lib-storage goes multipart (>5MB) it reports 0 (`total` is never emitted
    // for streams), which would fail every large upload. The stat's ETag also
    // anchors the settle-time write-race check below.
    const storedStat = await this.storage.getObjectStat(attachment.storagePath)

    // The reservation declared its byte count. A mismatch means a truncated
    // transfer or a caller lying about size — mark failed (retryable, the
    // next attempt overwrites the same key).
    if (storedStat.sizeBytes !== upload.expectedSizeBytes) {
      await withTransaction(this.pool, async (client) => {
        const failed = await AttachmentUploadRepository.markFailed(client, attachment.workspaceId, attachment.id, {
          code: "size_mismatch",
          message: `Expected ${upload.expectedSizeBytes} bytes, received ${storedStat.sizeBytes}`,
        })
        if (failed) {
          const row = await AttachmentRepository.findById(client, attachment.id)
          if (row) await this.publishUploadStatusChanged(client, row, AttachmentUploadStatuses.FAILED)
        }
      })
      return {
        status: "size_mismatch",
        expectedSizeBytes: upload.expectedSizeBytes,
        receivedSizeBytes: storedStat.sizeBytes,
      }
    }

    if (attachment.e2eOnly) {
      const settled = await withTransaction(this.pool, async (client) => {
        // Lock the row so this settle serializes with a concurrent
        // send binding the id — whichever commits second sees the other.
        const current = await AttachmentRepository.findByIdForUpdate(client, attachment.id)
        if (!current) throw new Error(`Attachment row missing for reservation ${attachment.id}`)
        const marked = await AttachmentUploadRepository.markUploaded(client, attachment.workspaceId, attachment.id)
        if (!marked) return null // concurrent duplicate — resolved below
        await this.transitionReservedSafety(client, current, AttachmentSafetyStatuses.E2E_UNSCANNED)
        await AttachmentRepository.updateProcessingStatus(client, attachment.id, ProcessingStatuses.SKIPPED)
        await AttachmentUploadRepository.deleteByAttachmentId(client, attachment.id)
        const updated = await AttachmentRepository.findById(client, attachment.id)
        if (!updated) throw new Error(`Attachment not found after upload completion: ${attachment.id}`)
        await this.publishUploadStatusChanged(client, updated, AttachmentUploadStatuses.UPLOADED)
        return updated
      })
      if (!settled) {
        const duplicate = await this.settledDuplicate(attachment.id)
        if (duplicate) return { status: "created", attachment: duplicate }
        throw new Error(`Attachment upload ${attachment.id} is not in a completable state`)
      }
      return { status: "created", attachment: settled }
    }

    // Bytes exist now — enter the scan window. Scan runs outside any
    // transaction (INV-41), then the settle transaction applies the verdict.
    const enteredScan = await withTransaction(this.pool, async (client) => {
      const current = await AttachmentRepository.findByIdForUpdate(client, attachment.id)
      if (!current) throw new Error(`Attachment row missing for reservation ${attachment.id}`)
      const marked = await AttachmentUploadRepository.markUploaded(client, attachment.workspaceId, attachment.id)
      if (!marked) return false // concurrent duplicate — resolved below
      await this.transitionReservedSafety(client, current, AttachmentSafetyStatuses.PENDING_SCAN)
      return true
    })
    if (!enteredScan) {
      const duplicate = await this.settledDuplicate(attachment.id)
      if (duplicate) return { status: "created", attachment: duplicate }
      throw new Error(`Attachment upload ${attachment.id} is not in a completable state`)
    }

    const scanResult = await this.malwareScanner.scan({
      storagePath: attachment.storagePath,
      filename: attachment.filename,
      mimeType: attachment.mimeType,
    })

    // The scan read bytes at a PATH; verify the object is still the exact
    // version this request validated (the entry stat's ETag) before blessing
    // the verdict — a concurrent POST to the same reservation could otherwise
    // land different bytes between the scan read and the verdict commit. The
    // HEAD runs BEFORE the settle transaction (INV-41: no network I/O while
    // holding a connection + row lock); the residual HEAD→commit window is a
    // few milliseconds, versus the whole scan duration without the check.
    const settleStat = await this.storage.getObjectStat(attachment.storagePath)
    if (settleStat.etag !== storedStat.etag) {
      await withTransaction(this.pool, async (client) => {
        const failed = await AttachmentUploadRepository.markFailed(client, attachment.workspaceId, attachment.id, {
          code: "concurrent_overwrite",
          message: "Stored bytes changed while the scan ran",
        })
        if (failed) {
          const row = await AttachmentRepository.findById(client, attachment.id)
          if (row) await this.publishUploadStatusChanged(client, row, AttachmentUploadStatuses.FAILED)
        }
      })
      return { status: "conflict", reason: "Stored bytes changed while the scan ran; retry the upload" }
    }

    const settled = await withTransaction(this.pool, async (client) => {
      const current = await AttachmentRepository.findByIdForUpdate(client, attachment.id)
      if (!current) throw new Error(`Attachment ${attachment.id} was deleted before safety status could be updated`)

      await this.transitionReservedSafety(client, current, scanResult.status)

      if (scanResult.status === AttachmentSafetyStatuses.CLEAN) {
        // Same worker trigger the synchronous upload path emits — caption,
        // thumbnail, extraction, and transcode dispatch from this event.
        await OutboxRepository.insert(client, "attachment:uploaded", {
          workspaceId: attachment.workspaceId,
          attachmentId: attachment.id,
          filename: attachment.filename,
          mimeType: attachment.mimeType,
          sizeBytes: storedStat.sizeBytes,
          storagePath: attachment.storagePath,
        })
      } else {
        await AttachmentRepository.updateProcessingStatus(client, attachment.id, ProcessingStatuses.SKIPPED)
        logger.warn(
          { attachmentId: attachment.id, reason: scanResult.reason ?? "unknown" },
          "Reserved attachment upload quarantined by malware scanner"
        )
      }

      await AttachmentUploadRepository.deleteByAttachmentId(client, attachment.id)
      const updated = await AttachmentRepository.findById(client, attachment.id)
      if (!updated) throw new Error(`Attachment not found after safety update: ${attachment.id}`)
      await this.publishUploadStatusChanged(client, updated, AttachmentUploadStatuses.UPLOADED)
      return updated
    })

    const blockReason = this.getSharingBlockReason(settled)
    if (!blockReason) return { status: "created", attachment: settled }

    // Quarantined: never keep the bytes. An unbound row is deleted outright
    // (mirrors createForUpload); a bound one stays as a blocked tombstone the
    // message renders, minus its S3 object.
    if (!settled.messageId) {
      try {
        await this.delete(settled.id)
      } catch (err) {
        logger.error({ err, attachmentId: settled.id }, "Failed to clean up quarantined reserved upload")
      }
    } else {
      try {
        await this.storage.delete(settled.storagePath)
      } catch (err) {
        logger.error({ err, attachmentId: settled.id }, "Failed to delete quarantined reserved upload bytes")
      }
    }
    return { status: "blocked", reason: blockReason }
  }

  /**
   * Client-reported terminal upload failure (retries exhausted, tab closing).
   * Without this, a dead upload keeps every viewer's chip on "Uploading…"
   * until the staleness sweep catches it hours later.
   */
  async reportUploadFailure(params: {
    workspaceId: string
    attachmentId: string
    userId: string
    errorMessage?: string
  }): Promise<ReportUploadFailureResult> {
    const upload = await AttachmentUploadRepository.findByAttachmentId(
      this.pool,
      params.workspaceId,
      params.attachmentId
    )
    if (!upload) return "not_found"
    if (upload.uploadedBy !== params.userId) return "forbidden"

    return withTransaction(this.pool, async (client) => {
      const failed = await AttachmentUploadRepository.markFailed(client, params.workspaceId, params.attachmentId, {
        code: "client_reported",
        message: params.errorMessage?.slice(0, 500) ?? null,
      })
      // CAS miss: already failed (idempotent re-report) or already settled —
      // a late report must not clobber an upload that actually completed.
      if (!failed) return upload.status === AttachmentUploadStatuses.FAILED ? "reported" : "already_settled"
      const row = await AttachmentRepository.findById(client, params.attachmentId)
      if (row) await this.publishUploadStatusChanged(client, row, AttachmentUploadStatuses.FAILED)
      return "reported"
    })
  }

  /**
   * Cron sweep for uploads whose client died without reporting: idle
   * reserved/uploading rows flip to `failed` (viewers see it), long-failed
   * rows flip to `abandoned` — deleting never-bound zombie attachment rows and
   * their S3 objects — and orphaned scan-window rows are dropped.
   */
  async sweepStaleUploads(options?: {
    failAfterMs?: number
    abandonAfterMs?: number
    batchSize?: number
  }): Promise<{ failed: number; abandoned: number; deleted: number }> {
    const failAfterMs = options?.failAfterMs ?? STALE_UPLOAD_FAIL_AFTER_MS
    const abandonAfterMs = options?.abandonAfterMs ?? STALE_UPLOAD_ABANDON_AFTER_MS
    const batchSize = options?.batchSize ?? STALE_UPLOAD_SWEEP_BATCH_SIZE

    const { failed, abandoned, orphanStoragePaths } = await withTransaction(this.pool, async (client) => {
      const failed = await AttachmentUploadRepository.failStale(client, {
        olderThan: new Date(Date.now() - failAfterMs),
        limit: batchSize,
      })
      const abandoned = await AttachmentUploadRepository.abandonStaleFailed(client, {
        olderThan: new Date(Date.now() - abandonAfterMs),
        limit: batchSize,
      })

      // Scan-window orphans (settle crashed after markUploaded): drop the
      // tracking row and quarantine any attachment still stuck pending_scan —
      // the boot-time stale-scan recovery deliberately skips rows this sweep
      // owns, so nothing else would ever settle them.
      const scanOrphans = await AttachmentUploadRepository.deleteStaleUploaded(client, {
        olderThan: new Date(Date.now() - failAfterMs),
        limit: batchSize,
      })
      const quarantinedIds =
        scanOrphans.length > 0
          ? new Set(
              await AttachmentRepository.quarantineStuckPendingScans(
                client,
                scanOrphans.map((u) => u.attachmentId)
              )
            )
          : new Set<string>()
      const scanOrphanEvents = scanOrphans
        .filter((u) => u.messageId && u.streamId && quarantinedIds.has(u.attachmentId))
        .map((u) => ({
          eventType: "attachment:upload_status_changed" as const,
          payload: {
            workspaceId: u.workspaceId,
            attachmentId: u.attachmentId,
            uploadStatus: AttachmentUploadStatuses.FAILED,
            safetyStatus: AttachmentSafetyStatuses.QUARANTINED,
            streamId: u.streamId!,
            messageId: u.messageId!,
          },
        }))
      if (scanOrphanEvents.length > 0) {
        await OutboxRepository.insertMany(client, scanOrphanEvents)
      }

      const bound = [...failed, ...abandoned].filter((u) => u.messageId && u.streamId)
      if (bound.length > 0) {
        await OutboxRepository.insertMany(
          client,
          bound.map((u) => ({
            eventType: "attachment:upload_status_changed" as const,
            payload: {
              workspaceId: u.workspaceId,
              attachmentId: u.attachmentId,
              uploadStatus: u.status,
              safetyStatus: AttachmentSafetyStatuses.PENDING_UPLOAD,
              streamId: u.streamId!,
              messageId: u.messageId!,
            },
          }))
        )
      }

      // Abandoned and never bound: nothing references the row — delete it (and
      // its tracking row) so zombies don't accumulate; S3 objects go after
      // commit (partial uploads may have left bytes at the reserved key).
      const orphans = abandoned.filter((u) => !u.messageId)
      if (orphans.length > 0) {
        const orphanIds = orphans.map((u) => u.attachmentId)
        await AttachmentRepository.deleteUnattachedByIds(client, orphanIds)
        await AttachmentUploadRepository.deleteByAttachmentIds(client, orphanIds)
      }

      return {
        failed: failed.length,
        abandoned: abandoned.length,
        orphanStoragePaths: orphans.flatMap((u) => (u.storagePath ? [u.storagePath] : [])),
      }
    })

    for (const storagePath of orphanStoragePaths) {
      try {
        await this.storage.delete(storagePath)
      } catch (err) {
        logger.warn({ err, storagePath }, "Failed to delete abandoned upload bytes")
      }
    }

    if (failed > 0 || orphanStoragePaths.length > 0) {
      logger.info({ failed, abandoned, deleted: orphanStoragePaths.length }, "Stale attachment upload sweep")
    }
    return { failed, abandoned, deleted: orphanStoragePaths.length }
  }

  /**
   * A duplicate completion lost its CAS (or found no tracking row) because a
   * concurrent request already settled the upload — two tabs resuming the same
   * persisted job both stream the same bytes, so the loser is a success too.
   * Returns the settled attachment, or null when the state is genuinely wrong.
   */
  private async settledDuplicate(attachmentId: string): Promise<Attachment | null> {
    const current = await AttachmentRepository.findById(this.pool, attachmentId)
    if (current && isAttachmentSafeForSharing(current.safetyStatus)) return current
    return null
  }

  /**
   * CAS the safety status off its expected reserved-flow predecessor,
   * tolerating an idempotent replay (already at the target) but failing loudly
   * on any other divergence.
   */
  private async transitionReservedSafety(
    client: PoolClient,
    current: Attachment,
    to: AttachmentSafetyStatus
  ): Promise<void> {
    if (current.safetyStatus === to) return
    const updated = await AttachmentRepository.updateSafetyStatus(client, current.id, to, {
      onlyIfStatusIn: [AttachmentSafetyStatuses.PENDING_UPLOAD, AttachmentSafetyStatuses.PENDING_SCAN],
    })
    if (!updated) {
      throw new Error(
        `Attachment ${current.id} safety status transition rejected from ${current.safetyStatus} to ${to}`
      )
    }
  }

  /**
   * Viewers only render upload state for attachments bound to a message —
   * unbound reservations live in the uploader's own composer, which tracks
   * them locally. Callers pass the row as read inside their transaction, so
   * the bound-ness check serializes with a concurrent send (both take the
   * row lock).
   */
  private async publishUploadStatusChanged(
    client: PoolClient,
    attachment: Attachment,
    uploadStatus: AttachmentUploadStatus
  ): Promise<void> {
    if (!attachment.messageId || !attachment.streamId) return
    await OutboxRepository.insert(client, "attachment:upload_status_changed", {
      workspaceId: attachment.workspaceId,
      attachmentId: attachment.id,
      uploadStatus,
      safetyStatus: attachment.safetyStatus,
      streamId: attachment.streamId,
      messageId: attachment.messageId,
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

  /**
   * No FKs (INV-1): whoever deletes the attachments row owns the cascade to its
   * child rows — extraction, upload tracking, and any persona context-attachment
   * binding (else a dangling row eats a persona cap slot forever). One helper for
   * every row-delete path so a new child table can't get cascaded in one deleter
   * but not the other.
   */
  private async cascadeChildRows(client: PoolClient, id: string): Promise<void> {
    await AttachmentExtractionRepository.deleteByAttachmentId(client, id)
    await AttachmentUploadRepository.deleteByAttachmentId(client, id)
    await AttachmentRepository.deletePersonaBindings(client, id)
  }

  async delete(id: string): Promise<boolean> {
    const storagePath = await withTransaction(this.pool, async (client) => {
      const attachment = await AttachmentRepository.findByIdForUpdate(client, id)
      if (!attachment) {
        return null
      }

      await this.cascadeChildRows(client, id)
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

  /**
   * Hard-delete an attachment ONLY while it is still free-floating (unbound to a
   * message and a stream), race-safe against a concurrent `attachToMessage`
   * (INV-20 — the predicate rides the DELETE). Used by the persona
   * context-attachment paths, where the file must never be destroyed once a
   * message has claimed it. Returns `{ deleted }`: `false` (extraction/upload
   * rows and the S3 object left intact) when the row was already claimed or gone.
   */
  async deleteIfUnbound(id: string): Promise<{ deleted: boolean }> {
    const storagePath = await withTransaction(this.pool, async (client) => {
      const path = await AttachmentRepository.deleteIfUnbound(client, id)
      if (path == null) {
        return null
      }
      await this.cascadeChildRows(client, id)
      return path
    })

    if (storagePath == null) {
      return { deleted: false }
    }

    await this.storage.delete(storagePath)
    return { deleted: true }
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
