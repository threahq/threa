import { copyFile, mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Pool } from "pg"
import { VideoStoryboardStatuses, VideoTranscodeStatuses, type VideoStoryboard } from "@threahq/types"
import { withTransaction } from "../../../db"
import { queueId } from "../../../lib/id"
import { logger } from "../../../lib/logger"
import { JobQueues } from "../../../lib/queue"
import { enqueueQueuedJob } from "../../../lib/queue/enqueue-with-id-retry"
import type { StorageProvider } from "../../../lib/storage/s3-client"
import { UndecodableMediaError, type MediaTools } from "../ffmpeg"
import type { Attachment } from "../repository"
import { AttachmentRepository } from "../repository"
import { VideoTranscodeJobRepository, isVideoAttachment } from "../video"
import {
  STORYBOARD_MIME_TYPE,
  STORYBOARD_SOURCE_URL_EXPIRES_SECONDS,
  STORYBOARD_TILE_CONCURRENCY,
  STORYBOARD_TILE_PATTERN,
  STORYBOARD_TILE_TIMEOUT_MS,
  StoryboardRowStatuses,
  storyboardStoragePath,
  storyboardTileName,
} from "./config"
import { grabTile, probeImageSize, probeVideoDurationMs, tileSprite } from "./ffmpeg"
import { storyboardLayout, tileTimeSeconds, type StoryboardLayout } from "./layout"
import { VideoStoryboardRepository, type VideoStoryboardRecord } from "./repository"

export interface VideoStoryboardServiceDeps {
  pool: Pool
  storage: StorageProvider
  /** Null when ffmpeg is not on PATH: every storyboard is unavailable. */
  tools: MediaTools | null
}

const UNAVAILABLE: VideoStoryboard = { status: VideoStoryboardStatuses.UNAVAILABLE }

function toWire(record: VideoStoryboardRecord): VideoStoryboard {
  if (record.status === StoryboardRowStatuses.PENDING) return { status: VideoStoryboardStatuses.PENDING }
  if (record.status !== StoryboardRowStatuses.READY) return UNAVAILABLE
  return {
    status: VideoStoryboardStatuses.READY,
    columns: record.columns!,
    rows: record.rows!,
    tileWidth: record.tileWidth!,
    tileHeight: record.tileHeight!,
    tileCount: record.tileCount!,
    intervalMs: record.intervalMs!,
  }
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false
  )
}

/**
 * Builds a video's hover-preview sprite on first request: frames are grabbed
 * by seeking over ranged HTTP (never a full download) and tiled into one JPEG.
 * No DB connection is held while ffmpeg runs (INV-41).
 */
export class VideoStoryboardService {
  private readonly pool: Pool
  private readonly storage: StorageProvider
  private readonly tools: MediaTools | null

  constructor(deps: VideoStoryboardServiceDeps) {
    this.pool = deps.pool
    this.storage = deps.storage
    this.tools = deps.tools
  }

  async ensure(attachment: Attachment): Promise<VideoStoryboard> {
    if (!this.tools || attachment.e2eOnly || !isVideoAttachment(attachment.mimeType, attachment.filename)) {
      return UNAVAILABLE
    }
    const { workspaceId, id: attachmentId } = attachment
    const existing = await VideoStoryboardRepository.find(this.pool, workspaceId, attachmentId)
    if (existing) return toWire(existing)

    const created = await withTransaction(this.pool, async (client) => {
      const inserted = await VideoStoryboardRepository.insertPending(client, workspaceId, attachmentId)
      if (inserted) {
        await enqueueQueuedJob(client, {
          queueName: JobQueues.VIDEO_STORYBOARD,
          workspaceId,
          payload: { workspaceId, attachmentId },
          processAfter: new Date(),
          generateId: queueId,
        })
      }
      return VideoStoryboardRepository.find(client, workspaceId, attachmentId)
    })
    if (!created) throw new Error(`Storyboard row for ${attachmentId} vanished after insert`)
    return toWire(created)
  }

  async findSpritePath(workspaceId: string, attachmentId: string): Promise<string | null> {
    const record = await VideoStoryboardRepository.find(this.pool, workspaceId, attachmentId)
    return record?.status === StoryboardRowStatuses.READY ? record.storagePath : null
  }

  async process(workspaceId: string, attachmentId: string): Promise<void> {
    const log = logger.child({ attachmentId })
    const record = await VideoStoryboardRepository.find(this.pool, workspaceId, attachmentId)
    if (record?.status !== StoryboardRowStatuses.PENDING) {
      log.debug("Storyboard missing or already settled, skipping")
      return
    }
    if (!this.tools) {
      await VideoStoryboardRepository.markFailed(this.pool, workspaceId, attachmentId, "ffmpeg is not available")
      return
    }
    const attachment = await AttachmentRepository.findById(this.pool, workspaceId, attachmentId)
    if (!attachment) {
      await VideoStoryboardRepository.markFailed(this.pool, workspaceId, attachmentId, "attachment not found")
      return
    }

    const transcode = await VideoTranscodeJobRepository.findByAttachmentId(this.pool, workspaceId, attachmentId)
    const sourcePath =
      transcode?.status === VideoTranscodeStatuses.COMPLETED && transcode.processedStoragePath
        ? transcode.processedStoragePath
        : attachment.storagePath
    const inputUrl = await this.storage.getSignedDownloadUrl(sourcePath, {
      expiresIn: STORYBOARD_SOURCE_URL_EXPIRES_SECONDS,
    })

    const tempDir = await mkdtemp(join(tmpdir(), "threa-storyboard-"))
    try {
      const durationMs = await probeVideoDurationMs(this.tools, inputUrl)
      if (durationMs === null) {
        log.warn("No video stream or duration in attachment, storyboard failed")
        await VideoStoryboardRepository.markFailed(this.pool, workspaceId, attachmentId, "no video stream")
        return
      }

      const layout = storyboardLayout(durationMs)
      const tilesWritten = await this.grabTiles(this.tools, inputUrl, tempDir, layout)
      if (!tilesWritten) {
        log.warn("First storyboard frame could not be read, storyboard failed")
        await VideoStoryboardRepository.markFailed(this.pool, workspaceId, attachmentId, "no frame at start")
        return
      }

      const spritePath = join(tempDir, "sprite.jpg")
      await tileSprite(this.tools, {
        tilePattern: join(tempDir, STORYBOARD_TILE_PATTERN),
        columns: layout.columns,
        rows: layout.rows,
        outputPath: spritePath,
      })
      const size = await probeImageSize(this.tools, spritePath)

      const storagePath = storyboardStoragePath(workspaceId, attachmentId)
      await this.storage.putObjectFile(storagePath, spritePath, STORYBOARD_MIME_TYPE)
      const committed = await VideoStoryboardRepository.markReady(this.pool, workspaceId, attachmentId, {
        storagePath,
        columns: layout.columns,
        rows: layout.rows,
        tileWidth: size.width / layout.columns,
        tileHeight: size.height / layout.rows,
        tileCount: layout.tileCount,
        intervalMs: layout.intervalMs,
      })
      log.info({ committed, tileCount: layout.tileCount, durationMs }, "Video storyboard processed")
    } catch (error) {
      if (!(error instanceof UndecodableMediaError)) throw error
      log.warn({ error }, "Video is not decodable, storyboard failed")
      await VideoStoryboardRepository.markFailed(this.pool, workspaceId, attachmentId, "not decodable")
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  }

  /** Returns false when tile 0 is missing; a later tile with no frame at or after its time reuses the previous one. */
  private async grabTiles(
    tools: MediaTools,
    inputUrl: string,
    dir: string,
    layout: StoryboardLayout
  ): Promise<boolean> {
    let next = 0
    const failures: unknown[] = []
    // A failed tile stops every lane, and all lanes settle before the caller removes the temp dir.
    const lane = async () => {
      while (next < layout.tileCount && failures.length === 0) {
        const index = next++
        try {
          await grabTile(tools, {
            inputUrl,
            seconds: tileTimeSeconds(layout, index),
            outputPath: join(dir, storyboardTileName(index)),
            timeoutMs: STORYBOARD_TILE_TIMEOUT_MS,
          })
        } catch (error) {
          failures.push(error)
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(STORYBOARD_TILE_CONCURRENCY, layout.tileCount) }, lane))
    if (failures.length > 0) throw failures[0]

    if (!(await exists(join(dir, storyboardTileName(0))))) return false
    for (let index = 1; index < layout.tileCount; index++) {
      const path = join(dir, storyboardTileName(index))
      if (!(await exists(path))) await copyFile(join(dir, storyboardTileName(index - 1)), path)
    }
    return true
  }
}
