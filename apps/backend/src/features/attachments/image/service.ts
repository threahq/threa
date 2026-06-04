import type { Pool } from "pg"
import sharp from "sharp"
import { withTransaction } from "../../../db"
import { logger } from "../../../lib/logger"
import type { StorageProvider } from "../../../lib/storage/s3-client"
import { OutboxRepository } from "../../../lib/outbox"
import { AttachmentRepository } from "../repository"
import {
  IMAGE_THUMBNAIL_MAX_DIMENSION,
  IMAGE_THUMBNAIL_WEBP_QUALITY,
  planGifThumbnailFrames,
  shouldGenerateThumbnail,
} from "./config"
import type { ImageThumbnailServiceLike } from "./types"

export interface ImageThumbnailServiceDeps {
  pool: Pool
  storage: StorageProvider
}

/**
 * Resizes uploaded images into a small WebP thumbnail for the stream view and
 * records the original orientation-corrected dimensions.
 *
 * Independent of `ImageCaptionService` on purpose: captioning needs an LLM and
 * can fail/skip, but the thumbnail must still be produced. This service never
 * touches `processing_status` (that state machine is owned by the extraction
 * pipeline) — thumbnail readiness is conveyed solely by
 * `thumbnail_storage_path` being set plus the `attachment:thumbnailed` event.
 *
 * S3 download + sharp work happen with no DB connection held (INV-41); the
 * single metadata read uses the pool directly (INV-30).
 */
export class ImageThumbnailService implements ImageThumbnailServiceLike {
  private readonly pool: Pool
  private readonly storage: StorageProvider

  constructor(deps: ImageThumbnailServiceDeps) {
    this.pool = deps.pool
    this.storage = deps.storage
  }

  async generateThumbnail(attachmentId: string): Promise<void> {
    const log = logger.child({ attachmentId })

    const attachment = await AttachmentRepository.findById(this.pool, attachmentId)
    if (!attachment) {
      log.warn("Attachment not found, skipping thumbnail generation")
      return
    }
    if (attachment.thumbnailStoragePath) {
      log.debug("Thumbnail already generated, skipping")
      return
    }
    if (!shouldGenerateThumbnail(attachment.mimeType, attachment.filename)) {
      log.debug({ mimeType: attachment.mimeType }, "Attachment is not a resizable image, skipping thumbnail")
      return
    }

    // Transient S3 errors propagate so the queue retries.
    const original = await this.storage.getObject(attachment.storagePath)

    let thumbnail: Buffer
    let width: number
    let height: number
    try {
      const metadata = await sharp(original).metadata()
      // sharp reports pre-orientation dimensions; EXIF orientations 5–8 are
      // rotated 90°, so the displayed (and thumbnail) box is width/height
      // swapped. Browsers auto-apply EXIF orientation to the raw image too, so
      // these swapped dims match both the inline thumbnail and the gallery.
      const swapped = (metadata.orientation ?? 1) >= 5
      const w = swapped ? metadata.height : metadata.width
      const h = swapped ? metadata.width : metadata.height
      if (!w || !h) {
        log.warn("Could not read image dimensions, skipping thumbnail")
        return
      }
      width = w
      height = h

      thumbnail = await this.renderThumbnail(original, metadata)
    } catch (error) {
      // A corrupt/unsupported image is not retryable — the raw file still
      // serves via the ?variant=thumbnail fallback, so this is non-fatal.
      log.warn({ error }, "Failed to decode/resize image, skipping thumbnail")
      return
    }

    const thumbnailPath = `${attachment.workspaceId}/${attachmentId}/thumbnail.webp`
    await this.storage.putObject(thumbnailPath, thumbnail, "image/webp")

    let committed = false
    await withTransaction(this.pool, async (client) => {
      committed = await AttachmentRepository.updateImageVariant(client, attachmentId, {
        thumbnailStoragePath: thumbnailPath,
        width,
        height,
      })
      // The attachment may have been deleted between the S3 work and now;
      // never emit a thumbnailed event for a write that did not land (INV-7).
      if (!committed) {
        log.warn("Attachment removed before thumbnail commit, skipping outbox emit")
        return
      }

      // Re-read for stream/message scoping — the attachment may have been
      // attached to a message between the initial read and now.
      const att = await AttachmentRepository.findById(client, attachmentId)
      await OutboxRepository.insert(client, "attachment:thumbnailed", {
        workspaceId: attachment.workspaceId,
        ...(att?.streamId && { streamId: att.streamId }),
        ...(att?.messageId && { messageId: att.messageId }),
        attachmentId,
        width,
        height,
      })
    })

    if (!committed) return
    log.info({ width, height, bytes: thumbnail.length }, "Image thumbnail generated")
  }

  /**
   * Encodes the resized thumbnail. Animated GIFs stay animated (frame-rate
   * capped); everything else collapses to a single orientation-corrected frame.
   */
  private async renderThumbnail(original: Buffer, metadata: sharp.Metadata): Promise<Buffer> {
    const isAnimatedGif = metadata.format === "gif" && (metadata.pages ?? 1) > 1
    if (isAnimatedGif) {
      return this.renderAnimatedGifThumbnail(original, metadata)
    }

    return sharp(original)
      .rotate()
      .resize(IMAGE_THUMBNAIL_MAX_DIMENSION, IMAGE_THUMBNAIL_MAX_DIMENSION, {
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ quality: IMAGE_THUMBNAIL_WEBP_QUALITY })
      .toBuffer()
  }

  /**
   * Resizes an animated GIF into a small animated WebP. All frames are resized
   * once, then the frame-rate cap (see {@link planGifThumbnailFrames}) decides
   * which frames survive: low-rate sources keep their pacing as-authored, while
   * high-rate sources are downsampled and re-timed to preserve total duration.
   */
  private async renderAnimatedGifThumbnail(original: Buffer, metadata: sharp.Metadata): Promise<Buffer> {
    const pages = metadata.pages ?? 1
    const plan = planGifThumbnailFrames(metadata.delay ?? [], pages)

    const resized = await sharp(original, { animated: true })
      .resize(IMAGE_THUMBNAIL_MAX_DIMENSION, IMAGE_THUMBNAIL_MAX_DIMENSION, {
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ quality: IMAGE_THUMBNAIL_WEBP_QUALITY })
      .toBuffer()

    // Already under the cap: keep the resized animation exactly as authored
    // (source loop count and per-frame delays are carried through by sharp).
    if (!plan.dropped) return resized

    // Capping collapsed the animation to a single frame — emit a static thumbnail.
    if (plan.keep.length < 2) {
      return sharp(resized, { page: plan.keep[0] ?? 0, pages: 1 })
        .webp({ quality: IMAGE_THUMBNAIL_WEBP_QUALITY })
        .toBuffer()
    }

    const frames = await Promise.all(
      plan.keep.map((index) => sharp(resized, { page: index, pages: 1 }).png().toBuffer())
    )
    return sharp(frames, { join: { animated: true } })
      .webp({ quality: IMAGE_THUMBNAIL_WEBP_QUALITY, delay: plan.delays, loop: metadata.loop ?? 0 })
      .toBuffer()
  }
}
