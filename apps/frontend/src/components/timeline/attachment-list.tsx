import React, { useState, useCallback, useEffect, useMemo } from "react"
import { Download, FileText, File, Loader2, Copy, Play, Globe } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Drawer, DrawerContent, DrawerTitle } from "@/components/ui/drawer"
import { MediaGallery, type GalleryItem } from "@/components/image-gallery"
import { Skeleton } from "@/components/ui/skeleton"
import { attachmentsApi, peekDownloadUrl } from "@/api"
import { cn } from "@/lib/utils"
import { downloadImage, copyImage, triggerDownload } from "@/lib/image-utils"
import { formatFileSize } from "@/lib/file-size"
import { useAttachmentContext } from "@/lib/markdown/attachment-context"
import { useMediaGallery } from "@/contexts"
import { useIsMobile } from "@/hooks/use-mobile"
import { useLongPress } from "@/hooks/use-long-press"
import { isHtmlAttachment, isMarkdownAttachment, isPdfAttachment } from "@/lib/attachment-kind"
import type { AttachmentSummary } from "@threa/types"

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
  /** Image variant: surface the resolved thumbnail URL to the parent so the
   *  gallery sidebar can render the same small image instead of waiting for the
   *  full-resolution variant to lazy-fetch on open. */
  onThumbnailLoaded?: (attachmentId: string, thumbnailUrl: string) => void
  isHighlighted?: boolean
  deferHydration?: boolean
}

interface VideoAttachmentItemProps {
  attachment: AttachmentSummary
  workspaceId: string
  onVideoClick?: (attachmentId: string) => void
  onThumbnailLoaded?: (attachmentId: string, thumbnailUrl: string) => void
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
  const handleDownload = useCallback(() => {
    onOpenChange(false)
    downloadImage(workspaceId, attachmentId, filename)
  }, [workspaceId, attachmentId, filename, onOpenChange])

  // Copy the full-resolution original, not the inline thumbnail.
  const handleCopy = useCallback(async () => {
    onOpenChange(false)
    try {
      const url = await attachmentsApi.getDownloadUrl(workspaceId, attachmentId)
      await copyImage(url)
    } catch {
      // copyImage surfaces its own failure toast; this guards the URL fetch.
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
            <Download className="h-[18px] w-[18px] text-muted-foreground shrink-0" />
            <span>Save image</span>
          </button>
          <button
            type="button"
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm active:bg-muted/80 transition-colors"
            onClick={handleCopy}
          >
            <Copy className="h-[18px] w-[18px] text-muted-foreground shrink-0" />
            <span>Copy image</span>
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
  onThumbnailLoaded,
  isHighlighted,
  deferHydration = false,
}: AttachmentItemProps) {
  // Seed from the resolved-presign cache so a warm remount (virtua
  // unmount/remount, bootstrap rewrite) renders the <img> on the very first
  // frame instead of replaying skeleton → async presign → fade.
  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(() =>
    peekDownloadUrl(workspaceId, attachment.id, { variant: "thumbnail" })
  )
  const [imgDecoded, setImgDecoded] = useState(false)
  const [error, setError] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const isMobile = useIsMobile()

  const box = inlineImageBox(attachment.width, attachment.height)

  useEffect(() => {
    if (deferHydration) return

    let mounted = true

    async function loadImage() {
      try {
        const url = await attachmentsApi.getDownloadUrl(workspaceId, attachment.id, { variant: "thumbnail" })
        if (mounted) {
          setThumbnailUrl(url)
          onThumbnailLoaded?.(attachment.id, url)
        }
      } catch {
        if (mounted) {
          setError(true)
        }
      }
    }

    loadImage()

    return () => {
      mounted = false
    }
  }, [workspaceId, attachment.id, deferHydration, onThumbnailLoaded])

  // The box is interactable as soon as it mounts — the gallery fetches the
  // full-resolution image itself, so opening it never depends on the inline
  // thumbnail finishing.
  const handleClick = useCallback(() => {
    onImageClick?.(attachment.id)
  }, [onImageClick, attachment.id])

  const openDrawer = useCallback(() => setDrawerOpen(true), [])
  const longPressRaw = useLongPress({
    onLongPress: openDrawer,
    enabled: isMobile && !!thumbnailUrl,
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
        {...(isMobile ? longPress.handlers : {})}
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
      {isMobile && thumbnailUrl && (
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
  onThumbnailLoaded,
  isHighlighted,
  deferHydration = false,
}: VideoAttachmentItemProps) {
  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState(false)

  const isProcessing = attachment.processingStatus === "pending" || attachment.processingStatus === "processing"
  const isFailed = attachment.processingStatus === "failed"
  const isSkipped = attachment.processingStatus === "skipped"

  useEffect(() => {
    if (deferHydration || isFailed || isProcessing) return

    if (isSkipped) {
      setThumbnailUrl(null)
      setIsLoading(false)
      setError(false)
      return
    }

    let mounted = true

    async function loadThumbnail() {
      try {
        setIsLoading(true)
        setError(false)
        const url = await attachmentsApi.getDownloadUrl(workspaceId, attachment.id, { variant: "thumbnail" })
        if (mounted) {
          setThumbnailUrl(url)
          onThumbnailLoaded?.(attachment.id, url)
        }
      } catch {
        if (mounted) {
          setError(true)
        }
      } finally {
        if (mounted) {
          setIsLoading(false)
        }
      }
    }

    loadThumbnail()

    return () => {
      mounted = false
    }
  }, [workspaceId, attachment.id, onThumbnailLoaded, deferHydration, isFailed, isProcessing, isSkipped])

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
  const [loadedFullImageUrls, setLoadedFullImageUrls] = useState<Map<string, string>>(new Map())
  const [loadedThumbnails, setLoadedThumbnails] = useState<Map<string, string>>(new Map())
  const [loadedVideoUrls, setLoadedVideoUrls] = useState<Map<string, string>>(new Map())
  // Markdown, HTML, and PDF attachments share a single URL cache: each viewer
  // just needs a presigned URL (the markdown viewer fetches text from it, the
  // HTML viewer hands it straight to a sandboxed iframe, the PDF viewer hands
  // it straight to the browser's built-in PDF renderer).
  const [loadedTextUrls, setLoadedTextUrls] = useState<Map<string, string>>(new Map())
  const attachmentContext = useAttachmentContext()
  const hoveredAttachmentId = attachmentContext?.hoveredAttachmentId ?? null
  const { mediaAttachmentId, openMedia, closeMedia } = useMediaGallery()

  // Only claim ownership when the URL param references one of our attachments
  const attachmentIds = useMemo(() => new Set((attachments ?? []).map((a) => a.id)), [attachments])
  const selectedAttachmentId = mediaAttachmentId && attachmentIds.has(mediaAttachmentId) ? mediaAttachmentId : null

  const imageAttachments = useMemo(
    () => (attachments ?? []).filter((a) => a.mimeType.startsWith("image/")),
    [attachments]
  )
  // Use processingStatus as the video discriminator — the backend sets it for
  // all video attachments, including application/octet-stream files with video
  // extensions that wouldn't match a pure mimeType.startsWith("video/") check.
  const videoAttachments = useMemo(
    () =>
      (attachments ?? []).filter(
        (a) => !a.mimeType.startsWith("image/") && a.processingStatus && a.processingStatus !== "failed"
      ),
    [attachments]
  )
  const failedVideoAttachments = useMemo(
    () => (attachments ?? []).filter((a) => !a.mimeType.startsWith("image/") && a.processingStatus === "failed"),
    [attachments]
  )
  const markdownAttachments = useMemo(
    () => (attachments ?? []).filter((a) => !a.processingStatus && isMarkdownAttachment(a)),
    [attachments]
  )
  const htmlAttachments = useMemo(
    () => (attachments ?? []).filter((a) => !a.processingStatus && isHtmlAttachment(a)),
    [attachments]
  )
  const pdfAttachments = useMemo(
    () => (attachments ?? []).filter((a) => !a.processingStatus && isPdfAttachment(a)),
    [attachments]
  )
  const fileAttachments = useMemo(
    () =>
      (attachments ?? []).filter(
        (a) =>
          !a.mimeType.startsWith("image/") &&
          !a.processingStatus &&
          !isMarkdownAttachment(a) &&
          !isHtmlAttachment(a) &&
          !isPdfAttachment(a)
      ),
    [attachments]
  )

  // Build gallery items — images + completed videos. Image items exist for
  // every image attachment (url empty until the full-resolution variant is
  // fetched on open) so the gallery can open instantly and show a loader,
  // mirroring the video lazy-fetch path.
  const galleryItems: GalleryItem[] = useMemo(() => {
    const imageItems: GalleryItem[] = imageAttachments.map((a) => ({
      type: "image" as const,
      url: loadedFullImageUrls.get(a.id) ?? "",
      thumbnailUrl: loadedThumbnails.get(a.id) ?? "",
      filename: a.filename,
      attachmentId: a.id,
    }))

    const videoItems: GalleryItem[] = videoAttachments
      .filter((a) => a.processingStatus === "completed" || a.processingStatus === "skipped")
      .map((a) => {
        const videoUrl = loadedVideoUrls.get(a.id) ?? ""
        const thumbnailUrl = loadedThumbnails.get(a.id) ?? ""
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
      url: loadedTextUrls.get(a.id) ?? "",
      filename: a.filename,
      attachmentId: a.id,
    }))

    const htmlItems: GalleryItem[] = htmlAttachments.map((a) => ({
      type: "html" as const,
      url: loadedTextUrls.get(a.id) ?? "",
      filename: a.filename,
      attachmentId: a.id,
    }))

    const pdfItems: GalleryItem[] = pdfAttachments.map((a) => ({
      type: "pdf" as const,
      url: loadedTextUrls.get(a.id) ?? "",
      filename: a.filename,
      attachmentId: a.id,
    }))

    return [...imageItems, ...videoItems, ...markdownItems, ...htmlItems, ...pdfItems]
  }, [
    imageAttachments,
    videoAttachments,
    markdownAttachments,
    htmlAttachments,
    pdfAttachments,
    loadedFullImageUrls,
    loadedThumbnails,
    loadedVideoUrls,
    loadedTextUrls,
  ])

  // Called by VideoAttachment children when their thumbnail loads
  const registerThumbnailUrl = useCallback((attachmentId: string, thumbnailUrl: string) => {
    setLoadedThumbnails((prev) => {
      if (prev.get(attachmentId) === thumbnailUrl) return prev
      const next = new Map(prev)
      next.set(attachmentId, thumbnailUrl)
      return next
    })
  }, [])

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

  // Eagerly fetch video URL when a video is selected (via click or URL param)
  useEffect(() => {
    if (!selectedAttachmentId) return
    const isVideo = videoAttachments.some((a) => a.id === selectedAttachmentId)
    if (!isVideo || loadedVideoUrls.has(selectedAttachmentId)) return

    let mounted = true
    async function fetchVideoUrl() {
      try {
        const url = await attachmentsApi.getDownloadUrl(workspaceId, selectedAttachmentId!, {
          variant: "processed",
        })
        if (mounted) {
          setLoadedVideoUrls((prev) => {
            const next = new Map(prev)
            next.set(selectedAttachmentId!, url)
            return next
          })
        }
      } catch {
        try {
          const url = await attachmentsApi.getDownloadUrl(workspaceId, selectedAttachmentId!)
          if (mounted) {
            setLoadedVideoUrls((prev) => {
              const next = new Map(prev)
              next.set(selectedAttachmentId!, url)
              return next
            })
          }
        } catch {
          console.error("Failed to get video URL")
        }
      }
    }
    fetchVideoUrl()
    return () => {
      mounted = false
    }
  }, [selectedAttachmentId, videoAttachments, loadedVideoUrls, workspaceId])

  // Lazily fetch the full-resolution original when an image is opened in the
  // gallery. The inline view only ever loads the small thumbnail variant, so
  // the lightbox must fetch the original itself on demand.
  useEffect(() => {
    if (!selectedAttachmentId) return
    const isImage = imageAttachments.some((a) => a.id === selectedAttachmentId)
    if (!isImage || loadedFullImageUrls.has(selectedAttachmentId)) return

    let mounted = true
    async function fetchFullImage() {
      try {
        const url = await attachmentsApi.getDownloadUrl(workspaceId, selectedAttachmentId!)
        if (mounted) {
          setLoadedFullImageUrls((prev) => {
            const next = new Map(prev)
            next.set(selectedAttachmentId!, url)
            return next
          })
        }
      } catch {
        console.error("Failed to get image URL")
      }
    }
    fetchFullImage()
    return () => {
      mounted = false
    }
  }, [selectedAttachmentId, imageAttachments, loadedFullImageUrls, workspaceId])

  // Lazy-fetch presigned URLs for markdown/html/pdf attachments when opened.
  useEffect(() => {
    if (!selectedAttachmentId) return
    const needsUrl =
      markdownAttachments.some((a) => a.id === selectedAttachmentId) ||
      htmlAttachments.some((a) => a.id === selectedAttachmentId) ||
      pdfAttachments.some((a) => a.id === selectedAttachmentId)
    if (!needsUrl || loadedTextUrls.has(selectedAttachmentId)) return

    let mounted = true
    async function fetchTextUrl() {
      try {
        const url = await attachmentsApi.getDownloadUrl(workspaceId, selectedAttachmentId!)
        if (mounted) {
          setLoadedTextUrls((prev) => {
            const next = new Map(prev)
            next.set(selectedAttachmentId!, url)
            return next
          })
        }
      } catch {
        console.error("Failed to get attachment URL")
      }
    }
    fetchTextUrl()
    return () => {
      mounted = false
    }
  }, [selectedAttachmentId, markdownAttachments, htmlAttachments, pdfAttachments, loadedTextUrls, workspaceId])

  if (!attachments || attachments.length === 0) {
    return null
  }

  const allFileAttachments = [...fileAttachments, ...failedVideoAttachments]

  return (
    <>
      <div className={cn("flex flex-col gap-2 mt-2", className)}>
        {(imageAttachments.length > 0 || videoAttachments.length > 0) && (
          <div className="flex flex-wrap gap-2">
            {imageAttachments.map((attachment) => (
              <ImageAttachment
                key={attachment.id}
                attachment={attachment}
                workspaceId={workspaceId}
                onImageClick={handleImageClick}
                onThumbnailLoaded={registerThumbnailUrl}
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
                onThumbnailLoaded={registerThumbnailUrl}
                isHighlighted={attachment.id === hoveredAttachmentId}
                deferHydration={deferHydration}
              />
            ))}
          </div>
        )}
        {(allFileAttachments.length > 0 ||
          markdownAttachments.length > 0 ||
          htmlAttachments.length > 0 ||
          pdfAttachments.length > 0) && (
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
