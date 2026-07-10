import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react"
import { Loader2, FileText, Image as ImageIcon, File as FileIcon, Film, Globe, AlertCircle } from "lucide-react"
import { AttachmentPill, type AttachmentPillStatus } from "@/components/composer/attachment-pill"
import { MediaGallery, type GalleryItem } from "@/components/image-gallery"
import { pendingGalleryId } from "@/components/gallery/pending-gallery-id"
import { buildPendingGalleryItem, uploadGalleryType, type UploadGalleryType } from "@/components/gallery/upload-preview"
import { useDecryptedAttachment } from "@/hooks/use-decrypted-attachment"
import { getAttachmentRef, type AttachmentRef } from "@/lib/crypto/attachment-crypto"
import { attachmentContentUrl } from "@/api"
import type { PendingAttachment } from "@/hooks/use-attachments"
import { formatFileSize } from "@/lib/file-size"

// Leading-slot icon for a previewable type, matching the gallery's own glyphs
// (Globe for html, FileText for docs, Film for video). Non-previewable files
// (type null — a zip, an unknown binary) fall back to the generic file icon.
function iconForType(type: UploadGalleryType | null): typeof FileIcon {
  switch (type) {
    case "image":
      return ImageIcon
    case "video":
      return Film
    case "pdf":
    case "markdown":
    case "text":
      return FileText
    case "html":
      return Globe
    default:
      return FileIcon
  }
}

const STATUS_MAP: Record<PendingAttachment["status"], AttachmentPillStatus> = {
  uploading: "pending",
  uploaded: "default",
  error: "error",
}

/** Stable identity across the temp→server id flip: the object URL never changes. */
function attachmentKey(a: PendingAttachment): string {
  return a.previewUrl ?? a.id
}

// Preview source for a chip that needs no decrypt: local bytes win for every
// previewable type (image/video/pdf/markdown/html/text) and double as the image
// thumbnail; otherwise a non-E2E image resolves to its deterministic content URL
// (thumbnail variant for the chip, full for the lightbox). Returns null for
// non-previewable files and for anything with no local bytes but a decryptable
// ref (routed to E2eChip). A present ref means "E2E, unlocked"; its absence here
// means non-E2E, where the content URL is real image bytes. Non-image types with
// no local bytes (a reloaded draft) have no static source — their server bytes
// sit behind a presign/decrypt this path doesn't reach, so they show a type icon
// until re-picked.
function staticSrc(
  a: PendingAttachment,
  type: UploadGalleryType | null,
  workspaceId: string | undefined
): { thumb?: string; full: string } | null {
  if (a.previewUrl) return { thumb: type === "image" ? a.previewUrl : undefined, full: a.previewUrl }
  if (type !== "image" || !workspaceId || getAttachmentRef(a.id)) return null
  return {
    thumb: attachmentContentUrl(workspaceId, a.id, { variant: "thumbnail" }),
    full: attachmentContentUrl(workspaceId, a.id),
  }
}

interface ChipViewProps {
  attachment: PendingAttachment
  /** Which gallery type this file previews as (drives the icon), or null. */
  galleryType: UploadGalleryType | null
  /** Leading-slot preview image; falls back to the type icon when absent/failed. */
  thumbnailSrc?: string
  /** Full-resolution URL for the lightbox, or null when not previewable. */
  fullSrc: string | null
  /** True while an E2E file's bytes are still decrypting. */
  decrypting?: boolean
  onRemove: (id: string) => void
  /** Abort an in-flight upload and drop the chip. Drives the × while uploading. */
  onCancelUpload: (id: string) => void
  onOpen: (key: string) => void
  onResolveSrc: (key: string, src: string | null) => void
}

function ChipView({
  attachment,
  galleryType,
  thumbnailSrc,
  fullSrc,
  decrypting,
  onRemove,
  onCancelUpload,
  onOpen,
  onResolveSrc,
}: ChipViewProps) {
  const key = attachmentKey(attachment)

  // Publish the full-res URL so the parent can build the lightbox item list.
  useEffect(() => {
    onResolveSrc(key, fullSrc)
  }, [key, fullSrc, onResolveSrc])
  useEffect(() => () => onResolveSrc(key, null), [key, onResolveSrc])

  const status = STATUS_MAP[attachment.status]
  const isUploading = attachment.status === "uploading"
  const isError = attachment.status === "error"
  // The × stays available while uploading so a file stuck on a flaky link can
  // be abandoned instead of holding the message hostage: it aborts the
  // transfer, drops the chip, and deletes the reservation.
  const removeHandler = isUploading ? () => onCancelUpload(attachment.id) : () => onRemove(attachment.id)
  const removeLabel = isUploading ? `Cancel upload of ${attachment.filename}` : `Remove ${attachment.filename}`
  const secondary = isError ? "Failed" : formatFileSize(attachment.sizeBytes)

  const isGenericError =
    isError &&
    (attachment.error === "Internal server error" || attachment.error === "Upload failed" || !attachment.error)
  let tooltip: string | undefined
  if (isGenericError) tooltip = "We couldn't upload this file. Please remove it and try again."
  else if (isError) tooltip = attachment.error

  let Icon = iconForType(galleryType)
  if (isUploading || decrypting) Icon = Loader2
  else if (isError) Icon = AlertCircle

  const canPreview = !!fullSrc && !isError

  return (
    <AttachmentPill
      icon={Icon}
      thumbnailSrc={thumbnailSrc}
      spinning={isUploading || decrypting}
      label={attachment.filename}
      secondary={secondary}
      status={status}
      tooltip={tooltip}
      onRemove={removeHandler}
      removeLabel={removeLabel}
      progress={isUploading ? attachment.progress : undefined}
      onActivate={canPreview ? () => onOpen(key) : undefined}
      activateLabel={`Preview ${attachment.filename}`}
      labelMaxWidth="max-w-[120px]"
    />
  )
}

/** Chip whose preview needs no decrypt: local object URL, non-E2E image thumbnail, or icon. */
function StaticChip(props: {
  attachment: PendingAttachment
  workspaceId: string | undefined
  onRemove: (id: string) => void
  onCancelUpload: (id: string) => void
  onOpen: (key: string) => void
  onResolveSrc: (key: string, src: string | null) => void
}) {
  const type = uploadGalleryType(props.attachment)
  const src = staticSrc(props.attachment, type, props.workspaceId)
  return <ChipView {...props} galleryType={type} thumbnailSrc={src?.thumb} fullSrc={src?.full ?? null} />
}

/** Chip for an E2E file: decrypts the bytes in memory (no server thumbnail exists). */
function E2eChip({
  attachmentRef,
  ...props
}: {
  attachment: PendingAttachment
  attachmentRef: AttachmentRef
  workspaceId: string
  onRemove: (id: string) => void
  onCancelUpload: (id: string) => void
  onOpen: (key: string) => void
  onResolveSrc: (key: string, src: string | null) => void
}) {
  const type = uploadGalleryType(props.attachment)
  const decrypted = useDecryptedAttachment(props.workspaceId, attachmentRef)
  const url = decrypted.status === "ready" ? decrypted.url : null
  return (
    <ChipView
      {...props}
      galleryType={type}
      thumbnailSrc={type === "image" ? (url ?? undefined) : undefined}
      fullSrc={url}
      decrypting={decrypted.status === "pending"}
    />
  )
}

interface PendingAttachmentsProps {
  attachments: PendingAttachment[]
  onRemove: (id: string) => void
  /** Abort an in-flight upload and drop its chip. */
  onCancelUpload?: (id: string) => void
  /**
   * Pills rendered inside the same flex-wrap row before the file pills.
   * Used by the composer to fold context-ref chips into the same visual
   * surface as file uploads — so users see one row of "things attached
   * to this message," not two stacked rows.
   */
  beforePills?: ReactNode
  /**
   * Anchors every preview source (non-E2E server thumbnail, E2E decrypt,
   * lightbox). Optional because the composer's own `workspaceId` is; every URL
   * path is guarded on its presence so a missing value yields an icon, never a
   * malformed `/api/workspaces//…` request (INV-11) — local previews and remove
   * still work without it.
   */
  workspaceId?: string
}

/**
 * Composer attachment row: every attachment renders as one uniform chip
 * (filename + size + remove ×). Previewable files (image/video/pdf/markdown/
 * html/text — decided by the same {@link uploadGalleryType} the timeline uses)
 * tap/click to open the shared lightbox; images also show a preview thumbnail in
 * the leading slot (from local bytes, the non-E2E server thumbnail, or an
 * in-memory E2E decrypt). Non-previewable files keep a plain type-icon chip.
 * Renders nothing when both lists are empty.
 */
export function PendingAttachments({
  attachments,
  onRemove,
  onCancelUpload,
  beforePills,
  workspaceId,
}: PendingAttachmentsProps) {
  // Open lightbox tracked by the stable attachment key, not the id (which flips
  // temp→server on upload completion), so an open preview survives its upload.
  const [openKey, setOpenKey] = useState<string | null>(null)
  // Preview URL per previewable chip, published by each chip (a chip owns the
  // E2E decrypt / object-URL lifecycle), so the lightbox item list has every source.
  const [srcByKey, setSrcByKey] = useState<Map<string, string>>(new Map())

  const onResolveSrc = useCallback((key: string, src: string | null) => {
    setSrcByKey((prev) => {
      if ((prev.get(key) ?? null) === src) return prev
      const next = new Map(prev)
      if (src) next.set(key, src)
      else next.delete(key)
      return next
    })
  }, [])

  const galleryItems = useMemo<GalleryItem[]>(
    () =>
      attachments
        .map((a): GalleryItem | null => {
          const type = uploadGalleryType(a)
          if (!type) return null
          const key = attachmentKey(a)
          const url = srcByKey.get(key)
          if (!url) return null
          return buildPendingGalleryItem(type, url, a.filename, key)
        })
        .filter((item): item is GalleryItem => item !== null),
    [attachments, srcByKey]
  )

  if (attachments.length === 0 && !beforePills) return null

  const galleryIndex = openKey ? galleryItems.findIndex((g) => g.attachmentId === pendingGalleryId(openKey)) : -1

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 mb-3 max-h-[120px] overflow-y-auto">
        {beforePills}
        {attachments.map((attachment) => {
          const key = attachmentKey(attachment)
          const ref =
            workspaceId && !attachment.previewUrl && uploadGalleryType(attachment) != null
              ? getAttachmentRef(attachment.id)
              : undefined
          const shared = {
            attachment,
            onRemove,
            onCancelUpload: onCancelUpload ?? onRemove,
            onOpen: setOpenKey,
            onResolveSrc,
          }
          return ref && workspaceId ? (
            <E2eChip key={key} attachmentRef={ref} workspaceId={workspaceId} {...shared} />
          ) : (
            <StaticChip key={key} workspaceId={workspaceId} {...shared} />
          )
        })}
      </div>

      {workspaceId && galleryItems.length > 0 && (
        <MediaGallery
          isOpen={galleryIndex !== -1}
          onClose={() => setOpenKey(null)}
          items={galleryItems}
          initialIndex={Math.max(0, galleryIndex)}
          workspaceId={workspaceId}
        />
      )}
    </>
  )
}
