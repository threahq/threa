import type { AttachmentSummary, AttachmentUploadStatus } from "@threa/types"
import type { Attachment } from "./repository"
import { isVideoAttachment } from "./video"
import { isImageAttachment } from "./image-caption"
import { isAttachmentSafeForSharing } from "./upload-safety-policy"

/**
 * Map a stored `Attachment` row to the lightweight `AttachmentSummary` wire
 * shape used in `message_created` event payloads and shared-message
 * hydration. The conditional carve-outs — `processingStatus` for videos,
 * `width`/`height` for images, and `safetyStatus`/`uploadStatus` for
 * still-settling reserved uploads — are the only variable bits; keeping them
 * in one place avoids drift between the timeline and shared-message paths
 * (INV-37).
 */
export function toAttachmentSummary(a: Attachment, uploadStatus?: AttachmentUploadStatus): AttachmentSummary {
  const isImage = isImageAttachment(a.mimeType, a.filename)
  return {
    id: a.id,
    filename: a.filename,
    mimeType: a.mimeType,
    sizeBytes: a.sizeBytes,
    // Only unsafe states ride the wire — absence means settled-and-safe, so
    // the common case (clean attachment) carries no extra fields.
    ...(!isAttachmentSafeForSharing(a.safetyStatus) && { safetyStatus: a.safetyStatus }),
    ...(uploadStatus && { uploadStatus }),
    ...(isVideoAttachment(a.mimeType, a.filename) && { processingStatus: a.processingStatus }),
    ...(isImage && a.width != null && a.height != null && { width: a.width, height: a.height }),
  }
}
