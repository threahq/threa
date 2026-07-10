import type { AttachmentSummary, AttachmentUploadStatus } from "@threa/types"
import type { Querier } from "../../db"
import type { Attachment } from "./repository"
import { AttachmentUploadRepository } from "./upload-repository"
import { isVideoAttachment } from "./video"
import { isImageAttachment } from "./image-caption"
import { isAttachmentSafeForSharing } from "./upload-safety-policy"

/**
 * Batch-fetch reserved-upload workflow statuses for the not-yet-shareable
 * attachments in a read model (one query per batch, INV-56), for the second
 * argument of {@link toAttachmentSummary}. Without it a failed reservation is
 * indistinguishable from one still uploading — both sit at `pending_upload` —
 * so viewers of that surface would render an eternal "Uploading…" chip.
 */
export async function fetchUploadStatuses(
  client: Querier,
  workspaceId: string,
  attachments: Attachment[]
): Promise<Map<string, AttachmentUploadStatus>> {
  const pendingIds = attachments.filter((a) => !isAttachmentSafeForSharing(a.safetyStatus)).map((a) => a.id)
  if (pendingIds.length === 0) return new Map()
  const uploads = await AttachmentUploadRepository.findByAttachmentIds(client, workspaceId, pendingIds)
  return new Map([...uploads].map(([id, upload]) => [id, upload.status]))
}

/**
 * Hydrate a per-message attachment map into wire summaries in one pass:
 * batch-fetches upload statuses for the whole map (INV-56), then maps each
 * message's rows through {@link toAttachmentSummary}. Shared by the board and
 * labeled-message read models so upload-state hydration can't drift between
 * them.
 */
export async function hydrateAttachmentSummaries(
  client: Querier,
  workspaceId: string,
  attachmentsByMessage: Map<string, Attachment[]>
): Promise<Map<string, AttachmentSummary[]>> {
  const uploadStatuses = await fetchUploadStatuses(client, workspaceId, [...attachmentsByMessage.values()].flat())
  return new Map(
    [...attachmentsByMessage].map(([messageId, rows]) => [
      messageId,
      rows.map((a) => toAttachmentSummary(a, uploadStatuses.get(a.id))),
    ])
  )
}

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
