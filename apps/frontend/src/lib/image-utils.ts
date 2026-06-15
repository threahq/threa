import { toast } from "sonner"
import { attachmentsApi } from "@/api"

/** Triggers a browser download by navigating to the given URL via an anchor element. */
export function triggerDownload(url: string, filename: string): void {
  const link = document.createElement("a")
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
}

/**
 * Downloads an image by requesting a presigned URL with Content-Disposition: attachment.
 * This avoids cross-origin fetch — the browser navigates directly to the S3 URL which
 * triggers a download thanks to the Content-Disposition header.
 *
 * Returns `true` on success so callers can render in-place confirmation (an icon
 * swap on the triggering button) rather than a toast. Failures still surface a
 * toast — there's no inline affordance to explain why a download didn't start.
 */
export async function downloadImage(workspaceId: string, attachmentId: string, filename: string): Promise<boolean> {
  try {
    const url = await attachmentsApi.getDownloadUrl(workspaceId, attachmentId, { download: true })
    triggerDownload(url, filename)
    return true
  } catch {
    toast.error("Failed to download image")
    return false
  }
}

/**
 * Copies an image to clipboard by fetching its blob data.
 * Requires S3 CORS to be configured for cross-origin fetch access.
 *
 * Returns `true` on success so the triggering button can show an in-place
 * checkmark instead of a toast; failures still toast (no inline affordance).
 */
export async function copyImage(url: string): Promise<boolean> {
  try {
    const response = await fetch(url)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const blob = await response.blob()

    if (!blob.type) throw new Error("Image has unknown MIME type")
    await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })])
    return true
  } catch {
    toast.error("Failed to copy image")
    return false
  }
}
