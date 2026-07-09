import type { AttachmentSummary } from "@threa/types"
import type { Attachment } from "./repository"
import { isVideoAttachment } from "./video"
import { isImageAttachment } from "./image-caption"

/**
 * Map a stored `Attachment` row to the lightweight `AttachmentSummary` wire
 * shape used in `message_created` event payloads and shared-message
 * hydration. The conditional carve-outs — `processingStatus` for videos and
 * `width`/`height` for images — are the only variable bits; keeping them in
 * one place avoids drift between the timeline and shared-message paths
 * (INV-37).
 */
export function toAttachmentSummary(a: Attachment): AttachmentSummary {
  const isImage = isImageAttachment(a.mimeType, a.filename)
  return {
    id: a.id,
    filename: a.filename,
    mimeType: a.mimeType,
    sizeBytes: a.sizeBytes,
    ...(a.uploadStatus && { uploadStatus: a.uploadStatus }),
    ...(!a.e2eOnly && { safetyStatus: a.safetyStatus }),
    ...(isVideoAttachment(a.mimeType, a.filename) && { processingStatus: a.processingStatus }),
    ...(isImage && a.width != null && a.height != null && { width: a.width, height: a.height }),
  }
}
