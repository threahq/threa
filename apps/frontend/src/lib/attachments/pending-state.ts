import type { AttachmentSummary } from "@threahq/types"

/**
 * A bound attachment whose bytes/scan haven't settled — or that failed or was
 * blocked. Messages are sent while uploads are still in flight, so the live
 * state rides the summary's safetyStatus/uploadStatus (patched by the
 * attachment:upload_status_changed socket event and refreshed by bootstrap
 * enrichment), never the frozen contentJson node attrs. Shared by the
 * attachment lists (status chips) and the inline markdown `attachment:` link
 * renderer so a message can't show contradicting signals for one file.
 */
export function attachmentPendingState(
  a: Pick<AttachmentSummary, "safetyStatus" | "uploadStatus">
): "uploading" | "scanning" | "failed" | "blocked" | null {
  if (a.safetyStatus === "quarantined") return "blocked"
  if (a.uploadStatus === "failed" || a.uploadStatus === "abandoned") return "failed"
  if (a.safetyStatus === "pending_upload") return "uploading"
  if (a.safetyStatus === "pending_scan") return "scanning"
  return null
}

export const PENDING_STATE_LABELS = {
  uploading: "Uploading…",
  scanning: "Scanning…",
  failed: "Upload failed",
  blocked: "Blocked by malware scan",
} as const
