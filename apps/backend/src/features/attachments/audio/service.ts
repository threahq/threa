import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Pool } from "pg"
import { ProcessingStatuses, type ProcessingStatus } from "@threahq/types"
import { withTransaction, type Querier } from "../../../db"
import { logger } from "../../../lib/logger"
import { OutboxRepository } from "../../../lib/outbox"
import type { StorageProvider } from "../../../lib/storage/s3-client"
import { AttachmentRepository } from "../repository"
import { toAttachmentAudioSummary } from "../summary"
import {
  AUDIO_NORMALIZED_FILENAME,
  AUDIO_NORMALIZED_MIME_TYPE,
  AUDIO_PCM_SAMPLE_RATE,
  AUDIO_PROCESS_TIMEOUT_MS,
  AUDIO_SOURCE_URL_EXPIRES_SECONDS,
  isPassthroughAudio,
  normalizedAudioStoragePath,
} from "./config"
import { UndecodableAudioError, probeAudio, runNormalize, type AudioTools } from "./ffmpeg"
import { PeakReducer } from "./waveform"

export interface AudioProcessingServiceLike {
  process(workspaceId: string, attachmentId: string): Promise<void>
}

export interface AudioProcessingServiceDeps {
  pool: Pool
  storage: StorageProvider
  tools: AudioTools
  timeoutMs?: number
}

const UNSETTLED: ProcessingStatus[] = [
  ProcessingStatuses.PENDING,
  ProcessingStatuses.PROCESSING,
  ProcessingStatuses.FAILED,
]

async function emitAudioProcessed(querier: Querier, workspaceId: string, attachmentId: string): Promise<void> {
  const att = await AttachmentRepository.findById(querier, workspaceId, attachmentId)
  if (!att) return
  await OutboxRepository.insert(querier, "attachment:audio_processed", {
    workspaceId,
    ...(att.streamId && { streamId: att.streamId }),
    ...(att.messageId && { messageId: att.messageId }),
    attachmentId,
    audio: toAttachmentAudioSummary(att),
  })
}

/** Ends an audio attachment without a result (skipped or failed) and tells clients, unless it already settled. */
export async function settleAudioWithoutResult(
  querier: Querier,
  workspaceId: string,
  attachmentId: string,
  status: typeof ProcessingStatuses.SKIPPED | typeof ProcessingStatuses.FAILED
): Promise<void> {
  const updated = await AttachmentRepository.updateProcessingStatus(querier, workspaceId, attachmentId, status, {
    onlyIfStatusIn: [ProcessingStatuses.PENDING, ProcessingStatuses.PROCESSING],
  })
  if (!updated) return
  await emitAudioProcessed(querier, workspaceId, attachmentId)
}

/**
 * Probes and decodes an uploaded audio file with ffmpeg straight from a
 * presigned URL, storing duration, waveform peaks and (unless the original
 * already plays everywhere) an AAC .m4a. No DB connection is held while
 * ffmpeg runs (INV-41).
 */
export class AudioProcessingService implements AudioProcessingServiceLike {
  private readonly pool: Pool
  private readonly storage: StorageProvider
  private readonly tools: AudioTools
  private readonly timeoutMs: number

  constructor(deps: AudioProcessingServiceDeps) {
    this.pool = deps.pool
    this.storage = deps.storage
    this.tools = deps.tools
    this.timeoutMs = deps.timeoutMs ?? AUDIO_PROCESS_TIMEOUT_MS
  }

  async process(workspaceId: string, attachmentId: string): Promise<void> {
    const log = logger.child({ attachmentId })

    const claimed = await AttachmentRepository.updateProcessingStatus(
      this.pool,
      workspaceId,
      attachmentId,
      ProcessingStatuses.PROCESSING,
      { onlyIfStatusIn: UNSETTLED }
    )
    if (!claimed) {
      log.debug("Audio attachment missing or already settled, skipping")
      return
    }
    const attachment = await AttachmentRepository.findById(this.pool, workspaceId, attachmentId)
    if (!attachment) return

    const inputUrl = await this.storage.getSignedDownloadUrl(attachment.storagePath, {
      expiresIn: AUDIO_SOURCE_URL_EXPIRES_SECONDS,
    })

    const tempDir = await mkdtemp(join(tmpdir(), "threa-audio-"))
    try {
      const probe = await probeAudio(this.tools, inputUrl)
      if (!probe) {
        log.warn("No audio stream in attachment, marking failed")
        await this.markFailed(workspaceId, attachmentId)
        return
      }

      const outputPath = isPassthroughAudio(probe) ? null : join(tempDir, AUDIO_NORMALIZED_FILENAME)
      const peaks = new PeakReducer()
      await runNormalize(this.tools, {
        inputUrl,
        outputPath,
        channels: probe.channels,
        timeoutMs: this.timeoutMs,
        onPcm: (chunk) => peaks.push(chunk),
      })

      const storagePath = outputPath ? normalizedAudioStoragePath(workspaceId, attachmentId) : null
      if (outputPath && storagePath) {
        await this.storage.putObjectFile(storagePath, outputPath, AUDIO_NORMALIZED_MIME_TYPE)
      }

      const durationMs = Math.round((peaks.sampleCount * 1000) / AUDIO_PCM_SAMPLE_RATE)
      const waveform = Buffer.from(peaks.finish()).toString("base64")

      const committed = await withTransaction(this.pool, async (client) => {
        const updated = await AttachmentRepository.updateAudioResult(client, workspaceId, attachmentId, {
          normalizedAudioStoragePath: storagePath,
          durationMs,
          waveform,
        })
        if (updated) await emitAudioProcessed(client, workspaceId, attachmentId)
        return updated
      })
      if (!committed) {
        log.warn("Audio attachment changed before result commit, skipping outbox emit")
        return
      }
      log.info({ codec: probe.codecName, passthrough: !storagePath, durationMs }, "Audio attachment processed")
    } catch (error) {
      if (!(error instanceof UndecodableAudioError)) throw error
      log.warn({ error }, "Audio attachment is not decodable, marking failed")
      await this.markFailed(workspaceId, attachmentId)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  }

  private async markFailed(workspaceId: string, attachmentId: string): Promise<void> {
    await withTransaction(this.pool, (client) =>
      settleAudioWithoutResult(client, workspaceId, attachmentId, ProcessingStatuses.FAILED)
    )
  }
}
