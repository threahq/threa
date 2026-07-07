import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react"
import { Loader2, FileText, Image as ImageIcon, File as FileIcon, AlertCircle } from "lucide-react"
import { AttachmentPill, type AttachmentPillStatus } from "@/components/composer/attachment-pill"
import { MediaGallery, type GalleryItem } from "@/components/image-gallery"
import { pendingGalleryId } from "@/components/gallery/pending-gallery-id"
import { useDecryptedAttachment } from "@/hooks/use-decrypted-attachment"
import { getAttachmentRef, type AttachmentRef } from "@/lib/crypto/attachment-crypto"
import { attachmentContentUrl } from "@/api"
import type { PendingAttachment } from "@/hooks/use-attachments"
import { formatFileSize } from "@/lib/file-size"

function getFileIcon(mimeType: string): typeof FileIcon {
  if (mimeType.startsWith("image/")) return ImageIcon
  if (mimeType.startsWith("text/") || mimeType === "application/pdf") return FileText
  return FileIcon
}

const STATUS_MAP: Record<PendingAttachment["status"], AttachmentPillStatus> = {
  uploading: "pending",
  uploaded: "default",
  error: "error",
}

function isImageAttachment(a: PendingAttachment): boolean {
  return a.mimeType.startsWith("image/")
}

/** Stable identity across the temp→server id flip: the object URL never changes. */
function attachmentKey(a: PendingAttachment): string {
  return a.previewUrl ?? a.id
}

// The preview source for an image without a decrypt step: local bytes win;
// otherwise the deterministic non-E2E content URL (thumbnail variant for the
// chip, full for the lightbox). Returns null for non-images and for E2E images
// (a ref is present → resolved via decrypt in E2eImageChip instead). Restore
// fires only after a draft decrypts, so a present ref means "E2E, unlocked";
// its absence here means non-E2E, where the content URL is a real image.
function staticImageSrc(a: PendingAttachment, workspaceId: string | undefined): { thumb: string; full: string } | null {
  if (a.previewUrl) return { thumb: a.previewUrl, full: a.previewUrl }
  if (!isImageAttachment(a) || !workspaceId || getAttachmentRef(a.id)) return null
  return {
    thumb: attachmentContentUrl(workspaceId, a.id, { variant: "thumbnail" }),
    full: attachmentContentUrl(workspaceId, a.id),
  }
}

interface ChipViewProps {
  attachment: PendingAttachment
  /** Leading-slot preview image; falls back to the type icon when absent/failed. */
  thumbnailSrc?: string
  /** Full-resolution URL for the lightbox, or null when not previewable. */
  fullSrc: string | null
  /** True while an E2E image's bytes are still decrypting. */
  decrypting?: boolean
  onRemove: (id: string) => void
  onOpen: (key: string) => void
  onResolveSrc: (key: string, src: string | null) => void
}

function ChipView({ attachment, thumbnailSrc, fullSrc, decrypting, onRemove, onOpen, onResolveSrc }: ChipViewProps) {
  const key = attachmentKey(attachment)

  // Publish the full-res URL so the parent can build the lightbox item list.
  useEffect(() => {
    onResolveSrc(key, fullSrc)
  }, [key, fullSrc, onResolveSrc])
  useEffect(() => () => onResolveSrc(key, null), [key, onResolveSrc])

  const status = STATUS_MAP[attachment.status]
  const isUploading = attachment.status === "uploading"
  const isError = attachment.status === "error"

  const isGenericError =
    isError &&
    (attachment.error === "Internal server error" || attachment.error === "Upload failed" || !attachment.error)
  let tooltip: string | undefined
  if (isGenericError) tooltip = "We couldn't upload this file. Please remove it and try again."
  else if (isError) tooltip = attachment.error

  let Icon = getFileIcon(attachment.mimeType)
  if (isUploading || decrypting) Icon = Loader2
  else if (isError) Icon = AlertCircle

  const canPreview = !!fullSrc && !isError

  return (
    <AttachmentPill
      icon={Icon}
      thumbnailSrc={thumbnailSrc}
      label={attachment.filename}
      secondary={isError ? "Failed" : formatFileSize(attachment.sizeBytes)}
      status={status}
      tooltip={tooltip}
      onRemove={isUploading ? undefined : () => onRemove(attachment.id)}
      removeLabel={`Remove ${attachment.filename}`}
      onActivate={canPreview ? () => onOpen(key) : undefined}
      activateLabel={`Preview ${attachment.filename}`}
      labelMaxWidth="max-w-[120px]"
    />
  )
}

/** Chip whose preview needs no decrypt: local object URL, non-E2E thumbnail, or icon. */
function StaticChip(props: {
  attachment: PendingAttachment
  workspaceId: string | undefined
  onRemove: (id: string) => void
  onOpen: (key: string) => void
  onResolveSrc: (key: string, src: string | null) => void
}) {
  const src = staticImageSrc(props.attachment, props.workspaceId)
  return <ChipView {...props} thumbnailSrc={src?.thumb} fullSrc={src?.full ?? null} />
}

/** Chip for an E2E image: decrypts the bytes in memory (no server thumbnail exists). */
function E2eImageChip({
  attachmentRef,
  ...props
}: {
  attachment: PendingAttachment
  attachmentRef: AttachmentRef
  workspaceId: string
  onRemove: (id: string) => void
  onOpen: (key: string) => void
  onResolveSrc: (key: string, src: string | null) => void
}) {
  const decrypted = useDecryptedAttachment(props.workspaceId, attachmentRef)
  const url = decrypted.status === "ready" ? decrypted.url : null
  return <ChipView {...props} thumbnailSrc={url ?? undefined} fullSrc={url} decrypting={decrypted.status === "pending"} />
}

interface PendingAttachmentsProps {
  attachments: PendingAttachment[]
  onRemove: (id: string) => void
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
 * (filename + size + remove ×). Image chips show a preview thumbnail in the
 * leading slot — from local bytes, the non-E2E server thumbnail, or an in-memory
 * E2E decrypt — and tap/click to open the shared lightbox; other types keep
 * their type icon. Renders nothing when both lists are empty.
 */
export function PendingAttachments({ attachments, onRemove, beforePills, workspaceId }: PendingAttachmentsProps) {
  // Open lightbox tracked by the stable attachment key, not the id (which flips
  // temp→server on upload completion), so an open preview survives its upload.
  const [openKey, setOpenKey] = useState<string | null>(null)
  // Full-res URL per image chip, published by each chip (a chip owns the E2E
  // decrypt / object-URL lifecycle), so the lightbox item list has every source.
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

  const imageAttachments = useMemo(() => attachments.filter(isImageAttachment), [attachments])

  const galleryItems = useMemo<GalleryItem[]>(
    () =>
      imageAttachments
        .map((a): GalleryItem | null => {
          const key = attachmentKey(a)
          const url = srcByKey.get(key)
          if (!url) return null
          return {
            type: "image",
            url,
            thumbnailUrl: url,
            filename: a.filename,
            attachmentId: pendingGalleryId(key),
          }
        })
        .filter((item): item is GalleryItem => item !== null),
    [imageAttachments, srcByKey]
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
            workspaceId && !attachment.previewUrl && isImageAttachment(attachment)
              ? getAttachmentRef(attachment.id)
              : undefined
          const shared = { attachment, onRemove, onOpen: setOpenKey, onResolveSrc }
          return ref && workspaceId ? (
            <E2eImageChip key={key} attachmentRef={ref} workspaceId={workspaceId} {...shared} />
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
