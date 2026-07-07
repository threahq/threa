import { useMemo, useState, type ReactNode } from "react"
import { Loader2, FileText, Image as ImageIcon, File as FileIcon, AlertCircle, X } from "lucide-react"
import { AttachmentPill, type AttachmentPillStatus } from "@/components/composer/attachment-pill"
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card"
import { MediaGallery, type GalleryItem } from "@/components/image-gallery"
import { pendingGalleryId } from "@/components/gallery/pending-gallery-id"
import type { PendingAttachment } from "@/hooks/use-attachments"
import { formatFileSize } from "@/lib/file-size"
import { cn } from "@/lib/utils"

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

/** An image attachment with local bytes we can preview inline. */
function hasImagePreview(a: PendingAttachment): a is PendingAttachment & { previewUrl: string } {
  return a.mimeType.startsWith("image/") && !!a.previewUrl
}

/**
 * Composer image preview: a small tile showing the actual image so users can
 * see what they attached before sending. Hovering enlarges it (desktop);
 * clicking/tapping opens the shared media lightbox. The preview is available
 * immediately — even while the upload is still in flight — because it reads the
 * local object URL, not the server copy.
 */
function PendingImageThumbnail({
  attachment,
  onRemove,
  onOpen,
}: {
  attachment: PendingAttachment & { previewUrl: string }
  onRemove: (id: string) => void
  onOpen: () => void
}) {
  const isUploading = attachment.status === "uploading"
  const isError = attachment.status === "error"

  const tile = (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Preview ${attachment.filename}`}
      title={isError ? attachment.error : undefined}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault()
          onOpen()
        }
      }}
      className={cn(
        "group/thumb relative h-12 w-12 shrink-0 cursor-pointer overflow-hidden rounded-md border bg-muted/30 transition-colors",
        "hover:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
        isError && "border-destructive"
      )}
    >
      <img
        src={attachment.previewUrl}
        alt={attachment.filename}
        draggable={false}
        className={cn("h-full w-full object-cover", (isUploading || isError) && "opacity-40")}
      />
      {isUploading && (
        <div className="absolute inset-0 flex items-center justify-center">
          <Loader2 className="h-4 w-4 animate-spin text-foreground/70" />
        </div>
      )}
      {isError && (
        <div className="absolute inset-0 flex items-center justify-center">
          <AlertCircle className="h-4 w-4 text-destructive" />
        </div>
      )}
      {!isUploading && (
        <button
          type="button"
          aria-label={`Remove ${attachment.filename}`}
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            onRemove(attachment.id)
          }}
          className="absolute right-0.5 top-0.5 rounded-full bg-background/80 p-0.5 text-foreground/70 opacity-0 transition-opacity hover:text-foreground group-hover/thumb:opacity-100 focus-visible:opacity-100"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  )

  return (
    <HoverCard openDelay={200} closeDelay={100}>
      <HoverCardTrigger asChild>{tile}</HoverCardTrigger>
      <HoverCardContent side="top" className="w-auto max-w-xs p-1">
        <img
          src={attachment.previewUrl}
          alt={attachment.filename}
          draggable={false}
          className="max-h-64 max-w-full rounded object-contain"
        />
      </HoverCardContent>
    </HoverCard>
  )
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
  /** Enables the lightbox download affordance; download is gated for previews regardless. */
  workspaceId?: string
}

/**
 * Composer attachment row: image uploads render as preview thumbnails
 * (hover to enlarge, click/tap to open the lightbox), everything else as a
 * labeled `<AttachmentPill>` — alongside any caller-provided `beforePills`
 * (typically context-ref chips) inside a single `flex flex-wrap` container.
 *
 * Renders nothing when both lists are empty.
 */
export function PendingAttachments({ attachments, onRemove, beforePills, workspaceId }: PendingAttachmentsProps) {
  // Track the open preview by object URL, not attachment id: the id flips from a
  // temp id to the server id when an upload completes, but the object URL is
  // stable, so an open lightbox survives its own upload finishing.
  const [openPreviewUrl, setOpenPreviewUrl] = useState<string | null>(null)

  const imageAttachments = useMemo(() => attachments.filter(hasImagePreview), [attachments])

  const galleryItems = useMemo<GalleryItem[]>(
    () =>
      imageAttachments.map((a) => ({
        type: "image" as const,
        url: a.previewUrl,
        thumbnailUrl: a.previewUrl,
        filename: a.filename,
        attachmentId: pendingGalleryId(a.previewUrl),
      })),
    [imageAttachments]
  )

  if (attachments.length === 0 && !beforePills) return null

  const galleryIndex = openPreviewUrl ? imageAttachments.findIndex((a) => a.previewUrl === openPreviewUrl) : -1

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 mb-3 max-h-[120px] overflow-y-auto">
        {beforePills}
        {attachments.map((attachment) => {
          if (hasImagePreview(attachment)) {
            return (
              <PendingImageThumbnail
                key={attachment.id}
                attachment={attachment}
                onRemove={onRemove}
                onOpen={() => setOpenPreviewUrl(attachment.previewUrl)}
              />
            )
          }

          const status = STATUS_MAP[attachment.status]
          const isUploading = attachment.status === "uploading"
          const isError = attachment.status === "error"
          let Icon = getFileIcon(attachment.mimeType)
          if (isUploading) Icon = Loader2
          else if (isError) Icon = AlertCircle

          const isGenericError =
            isError &&
            (attachment.error === "Internal server error" || attachment.error === "Upload failed" || !attachment.error)
          let tooltip: string | undefined
          if (isGenericError) tooltip = "We couldn't upload this file. Please remove it and try again."
          else if (isError) tooltip = attachment.error

          return (
            <AttachmentPill
              key={attachment.id}
              icon={Icon}
              label={attachment.filename}
              secondary={isError ? "Failed" : formatFileSize(attachment.sizeBytes)}
              status={status}
              tooltip={tooltip}
              onRemove={isUploading ? undefined : () => onRemove(attachment.id)}
              removeLabel={`Remove ${attachment.filename}`}
              labelMaxWidth="max-w-[120px]"
            />
          )
        })}
      </div>

      {galleryItems.length > 0 && (
        <MediaGallery
          isOpen={galleryIndex !== -1}
          onClose={() => setOpenPreviewUrl(null)}
          items={galleryItems}
          initialIndex={Math.max(0, galleryIndex)}
          workspaceId={workspaceId ?? ""}
        />
      )}
    </>
  )
}
