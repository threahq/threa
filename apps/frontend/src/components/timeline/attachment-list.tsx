import React, { useState, useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react"
import { Download, FileText, File, Loader2, Copy, Play, Globe, Check, RotateCcw, ShieldAlert } from "lucide-react"
import { Button } from "@/components/ui/button"
import { PillProgressBar } from "@/components/composer/attachment-pill"
import { attachmentPendingState, PENDING_STATE_LABELS } from "@/lib/attachments/pending-state"
import { Drawer, DrawerContent, DrawerTitle } from "@/components/ui/drawer"
import { MediaGallery, type GalleryItem } from "@/components/image-gallery"
import { useGalleryAttachmentUrls, type GalleryUrlKind } from "@/components/gallery/use-gallery-attachment-urls"
import { Skeleton } from "@/components/ui/skeleton"
import { attachmentsApi, attachmentContentUrl } from "@/api"
import { cn } from "@/lib/utils"
import { downloadImage, copyImage, triggerDownload } from "@/lib/image-utils"
import { formatFileSize } from "@/lib/file-size"
import { useAttachmentContext } from "@/lib/markdown/attachment-context"
import { useMediaGallery } from "@/contexts"
import { useTouchCapable } from "@/hooks/use-touch-capable"
import { useLongPress } from "@/hooks/use-long-press"
import {
  isHtmlAttachment,
  isMarkdownAttachment,
  isPdfAttachment,
  isTextPreviewableAttachment,
} from "@/lib/attachment-kind"
import type { AttachmentSummary } from "@threa/types"
import {
  subscribeUploads,
  getUploadsVersion,
  getUploadJobByAttachmentId,
  retryUpload,
} from "@/lib/uploads/upload-manager"

interface AttachmentListProps {
  attachments: AttachmentSummary[]
  workspaceId: string
  className?: string
  /** Defer image URL hydration until coordinated reveal completes */
  deferHydration?: boolean
}

interface AttachmentItemProps {
  attachment: AttachmentSummary
  workspaceId: string
  onImageClick?: (attachmentId: string) => void
  isHighlighted?: boolean
  deferHydration?: boolean
}

interface VideoAttachmentItemProps {
  attachment: AttachmentSummary
  workspaceId: string
  onVideoClick?: (attachmentId: string) => void
  isHighlighted?: boolean
  deferHydration?: boolean
}

// Inline images render at a fixed height; width is derived from the
// attachment's intrinsic aspect ratio (when known) so the box is reserved
// before any bytes load. Falls back to a square when dimensions are absent
// (legacy attachments / thumbnail worker hasn't run yet).
const INLINE_IMAGE_HEIGHT = 128 // h-32
const INLINE_IMAGE_MAX_WIDTH = 320 // max-w-xs

function inlineImageBox(width?: number, height?: number): { width: number; height: number } {
  if (!width || !height || height <= 0) {
    return { width: INLINE_IMAGE_HEIGHT, height: INLINE_IMAGE_HEIGHT }
  }
  const scaled = Math.round((INLINE_IMAGE_HEIGHT * width) / height)
  return { width: Math.min(Math.max(scaled, 1), INLINE_IMAGE_MAX_WIDTH), height: INLINE_IMAGE_HEIGHT }
}

function getFileIcon(mimeType: string) {
  if (mimeType.startsWith("text/") || mimeType === "application/pdf") {
    return FileText
  }
  return File
}

function ImageActionDrawer({
  open,
  onOpenChange,
  filename,
  workspaceId,
  attachmentId,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  filename: string
  workspaceId: string
  attachmentId: string
}) {
  // Confirm in place: the row's icon swaps to a checkmark for a beat, then the
  // drawer dismisses itself — no toast (the source field stays visible on
  // mobile). Failures fall back to closing; copyImage/downloadImage surface
  // their own error toast.
  const [downloadDone, setDownloadDone] = useState(false)
  const [copyDone, setCopyDone] = useState(false)
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (open) {
      setDownloadDone(false)
      setCopyDone(false)
    }
    return () => {
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
    }
  }, [open])

  const handleDownload = useCallback(async () => {
    const ok = await downloadImage(workspaceId, attachmentId, filename)
    if (!ok) {
      onOpenChange(false)
      return
    }
    setDownloadDone(true)
    closeTimerRef.current = setTimeout(() => onOpenChange(false), 700)
  }, [workspaceId, attachmentId, filename, onOpenChange])

  // Copy the full-resolution original, not the inline thumbnail.
  const handleCopy = useCallback(async () => {
    try {
      const url = await attachmentsApi.getDownloadUrl(workspaceId, attachmentId)
      const ok = await copyImage(url)
      if (!ok) {
        onOpenChange(false)
        return
      }
      setCopyDone(true)
      closeTimerRef.current = setTimeout(() => onOpenChange(false), 700)
    } catch {
      // Guards the URL fetch; copyImage surfaces its own failure toast.
      onOpenChange(false)
    }
  }, [workspaceId, attachmentId, onOpenChange])

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent className="max-h-[85dvh]">
        <DrawerTitle className="sr-only">Image actions</DrawerTitle>
        <div className="px-4 pt-1 pb-3">
          <div className="rounded-xl bg-muted/60 px-3.5 py-2.5">
            <p className="text-sm text-foreground/80 truncate">{filename}</p>
          </div>
        </div>
        <div className="px-2 pb-[max(12px,env(safe-area-inset-bottom))]">
          <button
            type="button"
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm active:bg-muted/80 transition-colors"
            onClick={handleDownload}
          >
            {downloadDone ? (
              <Check className="h-[18px] w-[18px] text-primary shrink-0" />
            ) : (
              <Download className="h-[18px] w-[18px] text-muted-foreground shrink-0" />
            )}
            <span>{downloadDone ? "Download started" : "Save image"}</span>
          </button>
          <button
            type="button"
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm active:bg-muted/80 transition-colors"
            onClick={handleCopy}
          >
            {copyDone ? (
              <Check className="h-[18px] w-[18px] text-primary shrink-0" />
            ) : (
              <Copy className="h-[18px] w-[18px] text-muted-foreground shrink-0" />
            )}
            <span>{copyDone ? "Copied" : "Copy image"}</span>
          </button>
        </div>
      </DrawerContent>
    </Drawer>
  )
}

function ImageAttachment({
  attachment,
  workspaceId,
  onImageClick,
  isHighlighted,
  deferHydration = false,
}: AttachmentItemProps) {
  // Deterministic content URL — no presign round trip before the <img> has a
  // src, and the browser HTTP cache keys on it across sessions, so a warm
  // open paints from disk cache without re-downloading.
  const thumbnailUrl = deferHydration
    ? null
    : attachmentContentUrl(workspaceId, attachment.id, { variant: "thumbnail" })
  const [imgDecoded, setImgDecoded] = useState(false)
  const [error, setError] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const touchCapable = useTouchCapable()

  const box = inlineImageBox(attachment.width, attachment.height)

  // The box is interactable as soon as it mounts — the gallery fetches the
  // full-resolution image itself, so opening it never depends on the inline
  // thumbnail finishing.
  const handleClick = useCallback(() => {
    onImageClick?.(attachment.id)
  }, [onImageClick, attachment.id])

  const openDrawer = useCallback(() => setDrawerOpen(true), [])
  const longPressRaw = useLongPress({
    onLongPress: openDrawer,
    enabled: touchCapable && !!thumbnailUrl,
  })

  // Wrap touch handlers to stop propagation — prevents the message-level
  // long-press from firing when the user holds on an image.
  const longPress = {
    isPressed: longPressRaw.isPressed,
    handlers: {
      onTouchStart: (e: React.TouchEvent) => {
        e.stopPropagation()
        longPressRaw.handlers.onTouchStart(e)
      },
      onTouchEnd: () => longPressRaw.handlers.onTouchEnd(),
      onTouchMove: (e: React.TouchEvent) => longPressRaw.handlers.onTouchMove(e),
      onContextMenu: (e: React.MouseEvent) => {
        e.stopPropagation()
        longPressRaw.handlers.onContextMenu(e)
      },
    },
  }

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.target !== e.currentTarget) return
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault()
        handleClick()
      }
    },
    [handleClick]
  )

  if (error) {
    return <div className="rounded-lg border bg-muted/50 p-2 text-xs text-muted-foreground">Failed to load image</div>
  }

  return (
    <>
      <div
        role="button"
        aria-label={attachment.filename}
        tabIndex={0}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        data-highlighted={isHighlighted || undefined}
        {...(touchCapable ? longPress.handlers : {})}
        style={{ width: box.width, height: box.height }}
        className={cn(
          "group/image relative overflow-hidden rounded-lg border bg-muted/30 transition-all cursor-pointer",
          "hover:border-primary hover:shadow-sm",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
          isHighlighted && "ring-2 ring-primary border-primary shadow-sm",
          longPress.isPressed && "opacity-70 transition-opacity duration-100"
        )}
      >
        {!imgDecoded && <Skeleton className="absolute inset-0 rounded-none" />}
        {thumbnailUrl && (
          <img
            // Cache fast path: when the browser already has the bytes (warm
            // remount — virtua unmount/remount, bootstrap rewrite), the image
            // is complete before onLoad ever fires. Flip imgDecoded during
            // commit so the row paints at full opacity instead of replaying
            // the skeleton → fade-in cycle on content that never left cache.
            ref={(node) => {
              if (node?.complete && node.naturalWidth > 0) setImgDecoded(true)
            }}
            src={thumbnailUrl}
            alt={attachment.filename}
            onLoad={() => setImgDecoded(true)}
            onError={() => setError(true)}
            className={cn(
              "absolute inset-0 h-full w-full object-cover transition-opacity duration-300",
              imgDecoded ? "opacity-100" : "opacity-0"
            )}
          />
        )}
      </div>
      {touchCapable && thumbnailUrl && (
        <ImageActionDrawer
          open={drawerOpen}
          onOpenChange={setDrawerOpen}
          filename={attachment.filename}
          workspaceId={workspaceId}
          attachmentId={attachment.id}
        />
      )}
    </>
  )
}

function VideoThumbnailContent({
  isProcessing,
  isLoading,
  error,
  thumbnailUrl,
  filename,
  onThumbnailError,
}: {
  isProcessing: boolean
  isLoading: boolean
  error: boolean
  thumbnailUrl: string | null
  filename: string
  onThumbnailError?: () => void
}) {
  if (isProcessing) {
    return (
      <div className="flex h-32 w-48 items-center justify-center">
        <div className="flex flex-col items-center gap-1.5">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          <span className="text-xs text-muted-foreground">Processing...</span>
        </div>
      </div>
    )
  }
  if (isLoading || error) {
    return (
      <div className="flex h-32 w-48 items-center justify-center bg-gradient-to-br from-muted/60 to-muted">
        {error ? (
          <div className="h-10 w-10 rounded-full bg-foreground/10 backdrop-blur-sm flex items-center justify-center">
            <Play className="h-5 w-5 text-muted-foreground ml-0.5" fill="currentColor" />
          </div>
        ) : (
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        )}
      </div>
    )
  }
  return (
    <div className="relative">
      <img
        src={thumbnailUrl!}
        alt={filename}
        className="h-32 w-auto max-w-xs object-cover"
        loading="lazy"
        onError={onThumbnailError}
      />
      <div className="absolute inset-0 flex items-center justify-center">
        <div className="h-10 w-10 rounded-full bg-black/60 flex items-center justify-center">
          <Play className="h-5 w-5 text-white ml-0.5" fill="white" />
        </div>
      </div>
    </div>
  )
}

function VideoAttachment({
  attachment,
  workspaceId,
  onVideoClick,
  isHighlighted,
  deferHydration = false,
}: VideoAttachmentItemProps) {
  const [error, setError] = useState(false)

  const isProcessing = attachment.processingStatus === "pending" || attachment.processingStatus === "processing"
  const isFailed = attachment.processingStatus === "failed"
  const isSkipped = attachment.processingStatus === "skipped"

  // Deterministic content URL (see ImageAttachment). Skipped transcodes have
  // no thumbnail object — the variant would fall through to raw video bytes,
  // which an <img> can't render, so they keep a null src.
  const thumbnailUrl =
    deferHydration || isProcessing || isFailed || isSkipped
      ? null
      : attachmentContentUrl(workspaceId, attachment.id, { variant: "thumbnail" })
  const isLoading = deferHydration

  const handleClick = useCallback(() => {
    if (!isProcessing && !isFailed) {
      onVideoClick?.(attachment.id)
    }
  }, [isProcessing, isFailed, onVideoClick, attachment.id])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.target !== e.currentTarget) return
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault()
        handleClick()
      }
    },
    [handleClick]
  )

  // Failed videos render as file download buttons
  if (isFailed) {
    return <FileAttachment attachment={attachment} workspaceId={workspaceId} isHighlighted={isHighlighted} />
  }

  return (
    <div
      role="button"
      aria-label={attachment.filename}
      tabIndex={isProcessing || isLoading ? -1 : 0}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      data-highlighted={isHighlighted || undefined}
      className={cn(
        "group/video relative overflow-hidden rounded-lg border bg-muted/30 transition-all",
        !isProcessing && "cursor-pointer hover:border-primary hover:shadow-sm",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
        isProcessing && "cursor-wait",
        isHighlighted && "ring-2 ring-primary border-primary shadow-sm"
      )}
    >
      <VideoThumbnailContent
        isProcessing={isProcessing}
        isLoading={isLoading}
        error={error}
        thumbnailUrl={thumbnailUrl}
        filename={attachment.filename}
        onThumbnailError={() => setError(true)}
      />
    </div>
  )
}

function OpenableFileChip({
  attachment,
  isHighlighted,
  icon: Icon,
  onOpen,
}: {
  attachment: AttachmentSummary
  isHighlighted?: boolean
  icon: typeof FileText
  onOpen: (attachmentId: string) => void
}) {
  return (
    <Button
      variant="outline"
      size="sm"
      className={cn("h-8 gap-2 text-xs", isHighlighted && "ring-2 ring-primary border-primary shadow-sm")}
      onClick={() => onOpen(attachment.id)}
    >
      <Icon className="h-3.5 w-3.5" />
      <span className="max-w-[150px] truncate">{attachment.filename}</span>
      <span className="text-muted-foreground">{formatFileSize(attachment.sizeBytes)}</span>
    </Button>
  )
}

export { attachmentPendingState }

export interface PendingChipInfo {
  attachment: AttachmentSummary
  state: "uploading" | "scanning" | "failed" | "blocked"
  /** Bytes fraction when this device owns the transfer (the sender's tab). */
  progress?: number
  /** True when this device still holds the bytes and can restart the upload. */
  canRetry: boolean
}

/**
 * Live upload jobs on THIS device (the sender's tab) override the summary:
 * they carry real progress and settle instantly on completion, ahead of the
 * socket patch. Other viewers rely on the summary state alone. Shared by the
 * plaintext and E2E attachment lists. Callers must subscribe to
 * `subscribeUploads` for live job updates.
 */
export function resolveUploadChip(a: AttachmentSummary): PendingChipInfo | null {
  const job = getUploadJobByAttachmentId(a.id)
  if (job) {
    if (job.status === "error") return { attachment: a, state: "failed", canRetry: true }
    if (job.status === "uploaded") return null // settled locally; render normally
    return { attachment: a, state: "uploading", progress: job.progress, canRetry: false }
  }
  const state = attachmentPendingState(a)
  return state ? { attachment: a, state, canRetry: false } : null
}

/**
 * Inert status chip for a not-yet-downloadable attachment. Excluded from every
 * interactive partition — its bytes may not exist, so previews/downloads would
 * 404 or be rejected server-side with no explanation. A failed upload whose
 * bytes are still on this device offers an in-place retry.
 */
export function PendingAttachmentChip({ attachment, state, progress, canRetry }: PendingChipInfo) {
  // max-w-full + a shrinkable filename keep the chip inside its column on
  // phones — a fixed-width name next to a long status string overflows the
  // viewport and clips the actionable part (INV-21). The filename gives way
  // first; the status text truncates only after the name has collapsed.
  if (state === "failed" && canRetry) {
    return (
      <Button
        variant="outline"
        size="sm"
        className="h-8 max-w-full gap-2 text-xs"
        onClick={() => retryUpload(attachment.id)}
        aria-label={`Upload failed — retry ${attachment.filename}`}
      >
        <RotateCcw className="h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{attachment.filename}</span>
        <span className="shrink-0 text-destructive">Retry</span>
      </Button>
    )
  }
  const ICONS = { uploading: Loader2, scanning: Loader2, failed: File, blocked: ShieldAlert }
  const Icon = ICONS[state]
  const showProgress = state === "uploading" && typeof progress === "number" && progress < 1
  return (
    <Button variant="outline" size="sm" className="relative h-8 max-w-full gap-2 overflow-hidden text-xs" disabled>
      <Icon className={cn("h-3.5 w-3.5 shrink-0", (state === "uploading" || state === "scanning") && "animate-spin")} />
      <span className="min-w-0 flex-1 truncate">{attachment.filename}</span>
      <span
        className={cn(
          "min-w-0 truncate",
          state === "failed" || state === "blocked" ? "text-destructive" : "text-muted-foreground"
        )}
      >
        {PENDING_STATE_LABELS[state]}
      </span>
      {showProgress && <PillProgressBar progress={progress} label={attachment.filename} />}
    </Button>
  )
}

function FileAttachment({ attachment, workspaceId, isHighlighted }: AttachmentItemProps) {
  const [isDownloading, setIsDownloading] = useState(false)
  const Icon = getFileIcon(attachment.mimeType)

  const handleDownload = useCallback(async () => {
    setIsDownloading(true)
    try {
      const url = await attachmentsApi.getDownloadUrl(workspaceId, attachment.id)
      triggerDownload(url, attachment.filename)
    } catch (error) {
      console.error("Failed to download attachment:", error)
    } finally {
      setIsDownloading(false)
    }
  }, [workspaceId, attachment])

  return (
    <Button
      variant="outline"
      size="sm"
      className={cn("h-8 gap-2 text-xs", isHighlighted && "ring-2 ring-primary border-primary shadow-sm")}
      onClick={handleDownload}
      disabled={isDownloading}
    >
      {isDownloading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Icon className="h-3.5 w-3.5" />}
      <span className="max-w-[150px] truncate">{attachment.filename}</span>
      <span className="text-muted-foreground">{formatFileSize(attachment.sizeBytes)}</span>
      <Download className="h-3 w-3 opacity-50" />
    </Button>
  )
}

export function AttachmentList({ attachments, workspaceId, className, deferHydration = false }: AttachmentListProps) {
  const attachmentContext = useAttachmentContext()
  const hoveredAttachmentId = attachmentContext?.hoveredAttachmentId ?? null
  const { mediaAttachmentId, openMedia, closeMedia } = useMediaGallery()

  // Only claim ownership when the URL param references one of our attachments
  const attachmentIds = useMemo(() => new Set((attachments ?? []).map((a) => a.id)), [attachments])
  const selectedAttachmentId = mediaAttachmentId && attachmentIds.has(mediaAttachmentId) ? mediaAttachmentId : null

  useSyncExternalStore(subscribeUploads, getUploadsVersion, getUploadsVersion)
  const pendingUploadChips = useMemo(
    () =>
      (attachments ?? []).flatMap((a): PendingChipInfo[] => {
        const chip = resolveUploadChip(a)
        return chip ? [chip] : []
      }),
    // getUploadsVersion() is intentionally a dependency: local jobs progress
    // while `attachments` stays referentially stable.
    [attachments, getUploadsVersion()]
  )
  const settledAttachments = useMemo(() => {
    const pendingIds = new Set(pendingUploadChips.map((p) => p.attachment.id))
    return (attachments ?? []).filter((a) => !pendingIds.has(a.id))
  }, [attachments, pendingUploadChips])

  const imageAttachments = useMemo(
    () => settledAttachments.filter((a) => a.mimeType.startsWith("image/")),
    [settledAttachments]
  )
  // Use processingStatus as the video discriminator — the backend sets it for
  // all video attachments, including application/octet-stream files with video
  // extensions that wouldn't match a pure mimeType.startsWith("video/") check.
  const videoAttachments = useMemo(
    () =>
      settledAttachments.filter(
        (a) => !a.mimeType.startsWith("image/") && a.processingStatus && a.processingStatus !== "failed"
      ),
    [settledAttachments]
  )
  const failedVideoAttachments = useMemo(
    () => settledAttachments.filter((a) => !a.mimeType.startsWith("image/") && a.processingStatus === "failed"),
    [settledAttachments]
  )
  const markdownAttachments = useMemo(
    () => settledAttachments.filter((a) => !a.processingStatus && isMarkdownAttachment(a)),
    [settledAttachments]
  )
  const htmlAttachments = useMemo(
    () => settledAttachments.filter((a) => !a.processingStatus && isHtmlAttachment(a)),
    [settledAttachments]
  )
  const pdfAttachments = useMemo(
    () => settledAttachments.filter((a) => !a.processingStatus && isPdfAttachment(a)),
    [settledAttachments]
  )
  const textAttachments = useMemo(
    () => settledAttachments.filter((a) => !a.processingStatus && isTextPreviewableAttachment(a)),
    [settledAttachments]
  )
  const fileAttachments = useMemo(
    () =>
      settledAttachments.filter(
        (a) =>
          !a.mimeType.startsWith("image/") &&
          !a.processingStatus &&
          !isMarkdownAttachment(a) &&
          !isHtmlAttachment(a) &&
          !isPdfAttachment(a) &&
          !isTextPreviewableAttachment(a)
      ),
    [settledAttachments]
  )

  // Build gallery items — images + completed videos. Image URLs are
  // deterministic content URLs (no presign), so they're set synchronously;
  // the gallery only loads the current item's full-resolution bytes, and the
  // sidebar reuses the inline thumbnail variant straight from browser cache.
  // Video playback keeps the lazy presigned URL (bytes stream straight from
  // S3 with native Range support).
  const selectedUrlKind: GalleryUrlKind = useMemo(() => {
    if (!selectedAttachmentId) return null
    if (videoAttachments.some((a) => a.id === selectedAttachmentId)) return "video"
    const isDocument =
      markdownAttachments.some((a) => a.id === selectedAttachmentId) ||
      htmlAttachments.some((a) => a.id === selectedAttachmentId) ||
      pdfAttachments.some((a) => a.id === selectedAttachmentId) ||
      textAttachments.some((a) => a.id === selectedAttachmentId)
    return isDocument ? "document" : null
  }, [selectedAttachmentId, videoAttachments, markdownAttachments, htmlAttachments, pdfAttachments, textAttachments])

  const galleryUrls = useGalleryAttachmentUrls(workspaceId, selectedAttachmentId, selectedUrlKind)

  const galleryItems: GalleryItem[] = useMemo(() => {
    const imageItems: GalleryItem[] = imageAttachments.map((a) => ({
      type: "image" as const,
      url: attachmentContentUrl(workspaceId, a.id),
      thumbnailUrl: attachmentContentUrl(workspaceId, a.id, { variant: "thumbnail" }),
      filename: a.filename,
      attachmentId: a.id,
    }))

    const videoItems: GalleryItem[] = videoAttachments
      .filter((a) => a.processingStatus === "completed" || a.processingStatus === "skipped")
      .map((a) => {
        const videoUrl = galleryUrls.get(a.id) ?? ""
        // Skipped transcodes have no thumbnail object; the variant URL would
        // fall through to raw video bytes, which an <img> can't render.
        const thumbnailUrl =
          a.processingStatus === "completed" ? attachmentContentUrl(workspaceId, a.id, { variant: "thumbnail" }) : ""
        return {
          type: "video" as const,
          url: videoUrl,
          thumbnailUrl,
          filename: a.filename,
          attachmentId: a.id,
        }
      })

    const markdownItems: GalleryItem[] = markdownAttachments.map((a) => ({
      type: "markdown" as const,
      url: galleryUrls.get(a.id) ?? "",
      filename: a.filename,
      attachmentId: a.id,
    }))

    const htmlItems: GalleryItem[] = htmlAttachments.map((a) => ({
      type: "html" as const,
      url: galleryUrls.get(a.id) ?? "",
      filename: a.filename,
      attachmentId: a.id,
    }))

    const pdfItems: GalleryItem[] = pdfAttachments.map((a) => ({
      type: "pdf" as const,
      url: galleryUrls.get(a.id) ?? "",
      filename: a.filename,
      attachmentId: a.id,
    }))

    const textItems: GalleryItem[] = textAttachments.map((a) => ({
      type: "text" as const,
      url: galleryUrls.get(a.id) ?? "",
      filename: a.filename,
      attachmentId: a.id,
    }))

    return [...imageItems, ...videoItems, ...markdownItems, ...htmlItems, ...pdfItems, ...textItems]
  }, [
    workspaceId,
    imageAttachments,
    videoAttachments,
    markdownAttachments,
    htmlAttachments,
    pdfAttachments,
    textAttachments,
    galleryUrls,
  ])

  // Track selected item by ID — derived index stays correct even as galleryItems grows
  const galleryIndex = selectedAttachmentId
    ? galleryItems.findIndex((g) => g.attachmentId === selectedAttachmentId)
    : -1

  const handleImageClick = useCallback(
    (attachmentId: string) => {
      openMedia(attachmentId)
    },
    [openMedia]
  )

  const handleVideoClick = useCallback(
    (attachmentId: string) => {
      openMedia(attachmentId)
    },
    [openMedia]
  )

  const handleTextOpen = useCallback(
    (attachmentId: string) => {
      openMedia(attachmentId)
    },
    [openMedia]
  )

  if (!attachments || attachments.length === 0) {
    return null
  }

  const allFileAttachments = [...fileAttachments, ...failedVideoAttachments]

  return (
    <>
      <div className={cn("flex flex-col gap-2 mt-2", className)}>
        {pendingUploadChips.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {pendingUploadChips.map((chip) => (
              <PendingAttachmentChip key={chip.attachment.id} {...chip} />
            ))}
          </div>
        )}
        {(imageAttachments.length > 0 || videoAttachments.length > 0) && (
          <div className="flex flex-wrap gap-2">
            {imageAttachments.map((attachment) => (
              <ImageAttachment
                key={attachment.id}
                attachment={attachment}
                workspaceId={workspaceId}
                onImageClick={handleImageClick}
                isHighlighted={attachment.id === hoveredAttachmentId}
                deferHydration={deferHydration}
              />
            ))}
            {videoAttachments.map((attachment) => (
              <VideoAttachment
                key={attachment.id}
                attachment={attachment}
                workspaceId={workspaceId}
                onVideoClick={handleVideoClick}
                isHighlighted={attachment.id === hoveredAttachmentId}
                deferHydration={deferHydration}
              />
            ))}
          </div>
        )}
        {(allFileAttachments.length > 0 ||
          markdownAttachments.length > 0 ||
          htmlAttachments.length > 0 ||
          pdfAttachments.length > 0 ||
          textAttachments.length > 0) && (
          <div className="flex flex-wrap gap-2">
            {markdownAttachments.map((attachment) => (
              <OpenableFileChip
                key={attachment.id}
                attachment={attachment}
                isHighlighted={attachment.id === hoveredAttachmentId}
                icon={FileText}
                onOpen={handleTextOpen}
              />
            ))}
            {htmlAttachments.map((attachment) => (
              <OpenableFileChip
                key={attachment.id}
                attachment={attachment}
                isHighlighted={attachment.id === hoveredAttachmentId}
                icon={Globe}
                onOpen={handleTextOpen}
              />
            ))}
            {pdfAttachments.map((attachment) => (
              <OpenableFileChip
                key={attachment.id}
                attachment={attachment}
                isHighlighted={attachment.id === hoveredAttachmentId}
                icon={FileText}
                onOpen={handleTextOpen}
              />
            ))}
            {textAttachments.map((attachment) => (
              <OpenableFileChip
                key={attachment.id}
                attachment={attachment}
                isHighlighted={attachment.id === hoveredAttachmentId}
                icon={FileText}
                onOpen={handleTextOpen}
              />
            ))}
            {allFileAttachments.map((attachment) => (
              <FileAttachment
                key={attachment.id}
                attachment={attachment}
                workspaceId={workspaceId}
                isHighlighted={attachment.id === hoveredAttachmentId}
              />
            ))}
          </div>
        )}
      </div>

      <MediaGallery
        isOpen={selectedAttachmentId !== null && galleryIndex !== -1}
        onClose={closeMedia}
        items={galleryItems.length > 0 ? galleryItems : []}
        initialIndex={Math.max(0, galleryIndex)}
        workspaceId={workspaceId}
        onItemChange={openMedia}
      />
    </>
  )
}
