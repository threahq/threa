import type { Pool } from "pg"
import { withTransaction } from "../../../db"
import { videoTranscodeJobId } from "../../../lib/id"
import { logger } from "../../../lib/logger"
import { AttachmentRepository } from "../repository"
import { VideoTranscodeJobRepository } from "./job-repository"
import { OutboxRepository } from "../../../lib/outbox"
import type { ThreaMediaConvertClient } from "./mediaconvert-client"
import type { S3Config } from "../../../lib/env"
import { ProcessingStatuses } from "@threahq/types"
import { VIDEO_TRANSCODE_MAX_AGE_MS } from "./config"

export interface VideoTranscodingServiceDeps {
  pool: Pool
  mediaConvertClient: ThreaMediaConvertClient
  s3Config: S3Config
}

export interface VideoTranscodingServiceLike {
  submit(attachmentId: string): Promise<void>
  checkStatus(attachmentId: string): Promise<boolean>
}

/**
 * Manages video transcoding via AWS MediaConvert.
 *
 * Follows the three-phase pattern (INV-41):
 * - Phase 1: DB operations (claim attachment, create tracking job)
 * - Phase 2: External API call (no DB connection held)
 * - Phase 3: DB operations (update status)
 */
export class VideoTranscodingService implements VideoTranscodingServiceLike {
  private readonly pool: Pool
  private readonly mediaConvertClient: ThreaMediaConvertClient
  private readonly s3Config: S3Config

  constructor(deps: VideoTranscodingServiceDeps) {
    this.pool = deps.pool
    this.mediaConvertClient = deps.mediaConvertClient
    this.s3Config = deps.s3Config
  }

  async submit(attachmentId: string): Promise<void> {
    const log = logger.child({ attachmentId })

    // Phase 1: Claim attachment and create tracking job
    const { attachment, job } = await withTransaction(this.pool, async (client) => {
      const att = await AttachmentRepository.findById(client, attachmentId)
      if (!att) {
        log.warn("Attachment not found, skipping video transcode")
        return { attachment: null, job: null }
      }

      const existingJob = await VideoTranscodeJobRepository.findByAttachmentId(client, attachmentId)
      if (att.processingStatus === ProcessingStatuses.PROCESSING && existingJob?.mediaconvertJobId) {
        log.info(
          { existingJobId: existingJob.id, mediaconvertJobId: existingJob.mediaconvertJobId },
          "Video transcode already submitted, skipping duplicate submit"
        )
        return { attachment: null, job: null }
      }

      const claimed = await AttachmentRepository.updateProcessingStatus(
        client,
        attachmentId,
        ProcessingStatuses.PROCESSING,
        // PROCESSING included for crash recovery: if the worker crashed after claiming
        // but before completing, the queue retries can resume. Existing submitted
        // jobs are filtered above to avoid duplicate MediaConvert submissions.
        { onlyIfStatusIn: [ProcessingStatuses.PENDING, ProcessingStatuses.FAILED, ProcessingStatuses.PROCESSING] }
      )

      if (!claimed) {
        log.info({ currentStatus: att.processingStatus }, "Attachment already claimed, skipping")
        return { attachment: null, job: null }
      }

      // Upsert: on retry after crash the previous tracking row still exists.
      const trackingJob = await VideoTranscodeJobRepository.upsert(client, {
        id: videoTranscodeJobId(),
        attachmentId,
        workspaceId: att.workspaceId,
      })

      return { attachment: att, job: trackingJob }
    })

    if (!attachment || !job) return

    // Phase 2: Submit to MediaConvert (no DB connection held — INV-41)
    const s3OutputPrefix = `${attachment.workspaceId}/${attachmentId}/`
    let mediaconvertJobId: string
    try {
      mediaconvertJobId = await this.mediaConvertClient.submitTranscodeJob({
        clientRequestToken: attachmentId,
        s3InputKey: attachment.storagePath,
        s3OutputPrefix,
      })
    } catch (error) {
      log.error({ error }, "Failed to submit MediaConvert job")
      await this.markFailed(job.id, attachmentId, `MediaConvert submission failed: ${error}`, attachment.workspaceId)
      return
    }

    // Phase 3: Update tracking job with MediaConvert job ID
    await VideoTranscodeJobRepository.updateSubmitted(this.pool, job.id, mediaconvertJobId)
    log.info({ mediaconvertJobId, jobId: job.id }, "Video transcode job submitted")
  }

  /**
   * Returns true when the job is terminal (completed or failed), false if still in progress.
   */
  async checkStatus(attachmentId: string): Promise<boolean> {
    const log = logger.child({ attachmentId })

    // Phase 1: Fetch tracking job (single query — pass pool directly per INV-30)
    const job = await VideoTranscodeJobRepository.findByAttachmentId(this.pool, attachmentId)

    if (!job) {
      log.warn("Video transcode job not found, treating as done")
      return true
    }

    if (job.status === "completed" || job.status === "failed") {
      return true
    }

    if (!job.mediaconvertJobId) {
      log.warn("Transcode job has no MediaConvert job ID, marking as failed")
      await this.markFailed(job.id, attachmentId, "No MediaConvert job ID", job.workspaceId)
      return true
    }

    // Safety check: fail if job is too old
    const ageMs = Date.now() - job.createdAt.getTime()
    if (ageMs > VIDEO_TRANSCODE_MAX_AGE_MS) {
      log.warn({ ageMs }, "Transcode job exceeded max age, marking as failed")
      await this.markFailed(job.id, attachmentId, "Transcoding timed out", job.workspaceId)
      return true
    }

    // Phase 2: Poll MediaConvert (no DB connection held — INV-41)
    const status = await this.mediaConvertClient.getJobStatus(job.mediaconvertJobId)

    if (status.status === "COMPLETE") {
      const processedPath = `${job.workspaceId}/${attachmentId}/processed.mp4`
      const thumbnailPath = `${job.workspaceId}/${attachmentId}/thumbnail.0000000.jpg`

      await withTransaction(this.pool, async (client) => {
        await VideoTranscodeJobRepository.updateCompleted(client, job.id, processedPath, thumbnailPath)
        await AttachmentRepository.updateProcessingStatus(client, attachmentId, ProcessingStatuses.COMPLETED)

        // Fetch attachment to get streamId/messageId for scoping the outbox event
        const att = await AttachmentRepository.findById(client, attachmentId)
        await OutboxRepository.insert(client, "attachment:transcoded", {
          workspaceId: job.workspaceId,
          ...(att?.streamId && { streamId: att.streamId }),
          ...(att?.messageId && { messageId: att.messageId }),
          attachmentId,
          processingStatus: ProcessingStatuses.COMPLETED,
        })
      })

      log.info({ jobId: job.id }, "Video transcode completed")
      return true
    }

    if (status.status === "ERROR" || status.status === "CANCELED") {
      await this.markFailed(job.id, attachmentId, status.errorMessage ?? "Unknown error", job.workspaceId)
      return true
    }

    log.debug({ mediaconvertStatus: status.status }, "Transcode still in progress")
    return false
  }

  private async markFailed(
    jobId: string,
    attachmentId: string,
    errorMessage: string,
    workspaceId?: string
  ): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      await VideoTranscodeJobRepository.updateFailed(client, jobId, errorMessage)
      await AttachmentRepository.updateProcessingStatus(client, attachmentId, ProcessingStatuses.FAILED)

      const att = await AttachmentRepository.findById(client, attachmentId)
      const resolvedWorkspaceId = workspaceId ?? att?.workspaceId ?? ""
      await OutboxRepository.insert(client, "attachment:transcoded", {
        workspaceId: resolvedWorkspaceId,
        ...(att?.streamId && { streamId: att.streamId }),
        ...(att?.messageId && { messageId: att.messageId }),
        attachmentId,
        processingStatus: ProcessingStatuses.FAILED,
      })
    })

    logger.warn({ jobId, attachmentId, errorMessage }, "Video transcode failed")
  }
}
