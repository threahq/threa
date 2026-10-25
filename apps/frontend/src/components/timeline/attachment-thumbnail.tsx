import { useState, useCallback, useEffect, useRef, type MouseEvent, type ReactNode, type TouchEvent } from "react"
import { Check, Copy, Download } from "lucide-react"
import { Drawer, DrawerContent, DrawerTitle } from "@/components/ui/drawer"
import { attachmentsApi, attachmentContentUrl } from "@/api"
import { cn } from "@/lib/utils"
import { downloadImage, copyImage } from "@/lib/image-utils"
import { useTouchCapable } from "@/hooks/use-touch-capable"
import { useLongPress } from "@/hooks/use-long-press"

// Thumbnails render at a fixed height; width is derived from the attachment's
// intrinsic aspect ratio (when known) so the box is reserved before any bytes
// load. Falls back to a square when dimensions are absent (legacy attachments /
// thumbnail worker hasn't run yet).
const THUMBNAIL_HEIGHT = 128 // h-32
const THUMBNAIL_MAX_WIDTH = 320 // max-w-xs

export function thumbnailBox(width?: number, height?: number): { width: number; height: number } {
  if (!width || !height || height <= 0) {
    return { width: THUMBNAIL_HEIGHT, height: THUMBNAIL_HEIGHT }
  }
  const scaled = Math.round((THUMBNAIL_HEIGHT * width) / height)
  return { width: Math.min(Math.max(scaled, 1), THUMBNAIL_MAX_WIDTH), height: THUMBNAIL_HEIGHT }
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

interface ImageLongPressOptions {
  workspaceId: string
  attachmentId: string
  filename: string
  enabled: boolean
}

/**
 * Touch long-press on an image thumbnail opens the Save/Copy image drawer.
 * Spread `handlers` on the thumbnail and render `drawer` beside it: the
 * drawer's DOM lives in a portal, so it is safe next to phrasing content.
 */
export function useImageLongPressDrawer({ workspaceId, attachmentId, filename, enabled }: ImageLongPressOptions): {
  isPressed: boolean
  handlers: Partial<ReturnType<typeof useLongPress>["handlers"]>
  drawer: ReactNode
} {
  const [open, setOpen] = useState(false)
  const touchCapable = useTouchCapable()
  const active = touchCapable && enabled
  const openDrawer = useCallback(() => setOpen(true), [])
  const longPress = useLongPress({ onLongPress: openDrawer, enabled: active })

  if (!active) return { isPressed: false, handlers: {}, drawer: null }

  // Stop propagation so the message-level long-press does not also fire.
  return {
    isPressed: longPress.isPressed,
    handlers: {
      ...longPress.handlers,
      onTouchStart: (e: TouchEvent) => {
        e.stopPropagation()
        longPress.handlers.onTouchStart(e)
      },
      onContextMenu: (e: MouseEvent) => {
        e.stopPropagation()
        longPress.handlers.onContextMenu(e)
      },
    },
    drawer: (
      <ImageActionDrawer
        open={open}
        onOpenChange={setOpen}
        filename={filename}
        workspaceId={workspaceId}
        attachmentId={attachmentId}
      />
    ),
  }
}

export function useThumbnailLoadState() {
  const [decoded, setDecoded] = useState(false)
  const [error, setError] = useState(false)
  // Bumped to remount the <img> after a failed load — the sticky error state
  // would otherwise outlive the connectivity blip that caused it (an offline
  // sender's own just-settled image is the common case with background
  // uploads).
  const [retryNonce, setRetryNonce] = useState(0)

  const retryLoad = useCallback(() => {
    setError(false)
    setDecoded(false)
    setRetryNonce((n) => n + 1)
  }, [])
  useEffect(() => {
    if (!error) return
    window.addEventListener("online", retryLoad)
    return () => window.removeEventListener("online", retryLoad)
  }, [error, retryLoad])

  const markDecoded = useCallback(() => setDecoded(true), [])
  const markError = useCallback(() => setError(true), [])

  return { decoded, error, retryNonce, retryLoad, markDecoded, markError }
}

export function ThumbnailImg({
  src,
  alt,
  load,
}: {
  src: string
  alt: string
  load: ReturnType<typeof useThumbnailLoadState>
}) {
  return (
    <img
      // Remount on retry so the browser re-requests the same URL.
      key={load.retryNonce}
      // Cache fast path: when the browser already has the bytes (warm
      // remount — virtua unmount/remount, bootstrap rewrite), the image
      // is complete before onLoad ever fires. Flip decoded during commit
      // so the row paints at full opacity instead of replaying the
      // skeleton → fade-in cycle on content that never left cache.
      ref={(node) => {
        if (node?.complete && node.naturalWidth > 0) load.markDecoded()
      }}
      src={src}
      alt={alt}
      onLoad={load.markDecoded}
      onError={load.markError}
      className={cn(
        "absolute inset-0 h-full w-full object-cover transition-opacity duration-300",
        load.decoded ? "opacity-100" : "opacity-0"
      )}
    />
  )
}

interface InlineAttachmentImageProps {
  workspaceId: string
  attachmentId: string
  filename: string
  width?: number
  height?: number
  onOpen: (attachmentId: string, metaKey: boolean) => void
}

/**
 * Body-inline rendering of an image attachment. Renders inside a markdown
 * paragraph, so only phrasing elements (button/span/img).
 */
export function InlineAttachmentImage({
  workspaceId,
  attachmentId,
  filename,
  width,
  height,
  onOpen,
}: InlineAttachmentImageProps) {
  const thumbnailUrl = attachmentContentUrl(workspaceId, attachmentId, { variant: "thumbnail" })
  const load = useThumbnailLoadState()
  const longPress = useImageLongPressDrawer({ workspaceId, attachmentId, filename, enabled: true })
  const box = thumbnailBox(width, height)
  const boxClass = cn(
    "relative inline-block align-top overflow-hidden rounded-lg border bg-muted/30 my-1",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
  )

  if (load.error) {
    return (
      <button
        type="button"
        onClick={load.retryLoad}
        aria-label={`${filename} — failed to load, retry`}
        style={{ width: box.width, height: box.height }}
        className={cn(boxClass, "p-2 text-xs text-muted-foreground hover:border-primary")}
      >
        Failed to load image — tap to retry
      </button>
    )
  }

  return (
    <>
      <button
        type="button"
        aria-label={filename}
        onClick={(e) => onOpen(attachmentId, e.metaKey || e.ctrlKey)}
        {...longPress.handlers}
        style={{ width: box.width, height: box.height }}
        className={cn(
          boxClass,
          "cursor-pointer transition-all hover:border-primary hover:shadow-sm",
          longPress.isPressed && "opacity-70 transition-opacity duration-100"
        )}
      >
        {!load.decoded && <span className="absolute inset-0 animate-pulse bg-muted" />}
        <ThumbnailImg src={thumbnailUrl} alt={filename} load={load} />
      </button>
      {longPress.drawer}
    </>
  )
}
