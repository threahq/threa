import { useState, useSyncExternalStore } from "react"
import { toast } from "sonner"
import { Download, FileLock2, Loader2 } from "lucide-react"
import type { AttachmentSummary } from "@threa/types"
import { type AttachmentRef } from "@/lib/crypto/attachment-crypto"
import { requestAttachmentBytes } from "@/lib/crypto/attachment-cache"
import { fetchAndDecryptAttachment, useDecryptedAttachment } from "@/hooks/use-decrypted-attachment"
import { triggerDownload } from "@/lib/image-utils"
import { Button } from "@/components/ui/button"
import { subscribeUploads, getUploadsVersion } from "@/lib/uploads/upload-manager"
import { resolveUploadChip, PendingAttachmentChip } from "./attachment-list"
import { PillProgressBar } from "@/components/composer/attachment-pill"

/**
 * Renders the attachments of an E2E message from their decrypted refs. E2E
 * attachments can't use the normal `AttachmentList`: the server stores opaque
 * ciphertext with no thumbnails, variants, or real metadata, so we fetch the
 * raw ciphertext, decrypt it in-memory with the per-file key/iv from the ref,
 * and render from a blob URL. Images preview inline; everything else is a
 * decrypt-on-click download. The fetched bytes live in the shared
 * `attachment-cache`, so an image re-mounting on scroll doesn't re-fetch and
 * re-decrypt. Real filename/size come from the ref, never the server's placeholder.
 */

const PREFIX = "🔒 "

/** Same footprint as E2eImageAttachment's decrypting box (h-40 max-w-sm). */
function E2ePendingImageBox({
  state,
  progress,
  filename,
}: {
  state: "uploading" | "scanning"
  progress?: number
  filename: string
}) {
  return (
    <div className="relative flex h-40 w-full max-w-sm items-center justify-center overflow-hidden rounded-lg border bg-muted/40">
      <div className="flex flex-col items-center gap-1 px-2 text-center">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        <span className="text-[11px] text-muted-foreground">{state === "scanning" ? "Scanning…" : "Uploading…"}</span>
      </div>
      {state === "uploading" && typeof progress === "number" && progress < 1 && (
        <PillProgressBar progress={progress} label={filename} />
      )}
    </div>
  )
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function E2eImageAttachment({ workspaceId, attachmentRef }: { workspaceId: string; attachmentRef: AttachmentRef }) {
  const decrypted = useDecryptedAttachment(workspaceId, attachmentRef)

  if (decrypted.status === "failed")
    return <E2eFileAttachment workspaceId={workspaceId} attachmentRef={attachmentRef} />
  if (decrypted.status === "pending") {
    return (
      <div className="flex h-40 w-full max-w-sm items-center justify-center rounded-lg border bg-muted/40">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-label="Decrypting attachment" />
      </div>
    )
  }
  return (
    <img
      src={decrypted.url}
      alt={attachmentRef.filename}
      className="max-h-80 max-w-sm rounded-lg border object-contain"
      title={`${PREFIX}${attachmentRef.filename}`}
    />
  )
}

function E2eFileAttachment({ workspaceId, attachmentRef }: { workspaceId: string; attachmentRef: AttachmentRef }) {
  const [busy, setBusy] = useState(false)

  const handleDownload = async () => {
    if (busy) return
    setBusy(true)
    try {
      const entry = await requestAttachmentBytes(attachmentRef.attachmentId, () =>
        fetchAndDecryptAttachment(workspaceId, attachmentRef)
      )
      if (!entry.value) throw new Error("decrypt failed")
      const objectUrl = URL.createObjectURL(entry.value)
      triggerDownload(objectUrl, attachmentRef.filename)
      // Give the browser a beat to start the download before reclaiming the URL.
      setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000)
    } catch {
      toast.error("Couldn't decrypt this attachment")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex max-w-sm items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-sm">
      <FileLock2 className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">{attachmentRef.filename}</p>
        <p className="text-xs text-muted-foreground">{formatSize(attachmentRef.sizeBytes)} · encrypted</p>
      </div>
      <Button variant="outline" size="sm" className="h-7 shrink-0 gap-1 px-2" disabled={busy} onClick={handleDownload}>
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
        {busy ? "Decrypting…" : "Download"}
      </Button>
    </div>
  )
}

export function E2eAttachmentList({
  workspaceId,
  refs,
  attachments,
}: {
  workspaceId: string
  refs: AttachmentRef[]
  /**
   * The message's plaintext attachment summaries (placeholder metadata, but
   * live `safetyStatus`/`uploadStatus` via the socket patch + bootstrap
   * overlay). Send-while-uploading means a ref can point at bytes that don't
   * exist yet — attempting the decrypt then 403s and caches the failure, so
   * a still-settling ref renders a status chip until the upload lands.
   */
  attachments?: AttachmentSummary[]
}) {
  useSyncExternalStore(subscribeUploads, getUploadsVersion, getUploadsVersion)
  if (refs.length === 0) return null
  const summaryById = new Map((attachments ?? []).map((a) => [a.id, a]))
  return (
    <div className="mt-2 flex flex-col gap-2">
      {refs.map((ref) => {
        const summary = summaryById.get(ref.attachmentId)
        const chip = resolveUploadChip(
          summary ?? { id: ref.attachmentId, filename: ref.filename, mimeType: ref.mimeType, sizeBytes: ref.sizeBytes }
        )
        if (chip) {
          // Show the REAL name from the decrypted ref, not the server's
          // "encrypted" placeholder the summary carries.
          // In-flight images get an image-shaped placeholder for the same
          // INV-21 reason as the plaintext list: the settle should swap a
          // box's content, not replace a small chip with a full-size image.
          // The box mirrors E2eImageAttachment's decrypting state exactly, so
          // uploading → decrypting → image never reshapes until the final
          // (pre-existing) natural-size reveal. The ref's mimeType is
          // plaintext, so the split works while the summary says "encrypted".
          if ((chip.state === "uploading" || chip.state === "scanning") && ref.mimeType.startsWith("image/")) {
            return (
              <E2ePendingImageBox
                key={ref.attachmentId}
                state={chip.state}
                progress={chip.progress}
                filename={ref.filename}
              />
            )
          }
          return (
            <div key={ref.attachmentId} className="flex flex-wrap gap-2">
              <PendingAttachmentChip {...chip} attachment={{ ...chip.attachment, filename: ref.filename }} />
            </div>
          )
        }
        return ref.mimeType.startsWith("image/") ? (
          <E2eImageAttachment key={ref.attachmentId} workspaceId={workspaceId} attachmentRef={ref} />
        ) : (
          <E2eFileAttachment key={ref.attachmentId} workspaceId={workspaceId} attachmentRef={ref} />
        )
      })}
    </div>
  )
}
