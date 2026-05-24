import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import {
  X,
  Download,
  Copy,
  ChevronLeft,
  ChevronRight,
  PanelRightClose,
  PanelRightOpen,
  Loader2,
  Play,
  FileText,
  Globe,
  Code2,
  Eye,
} from "lucide-react"
import { TopbarLoadingIndicator } from "@/components/layout/topbar-loading-indicator"
import { downloadImage, copyImage } from "@/lib/image-utils"
import { useIsMobile } from "@/hooks/use-mobile"
import { cn } from "@/lib/utils"
import { attachmentsApi } from "@/api"
import { triggerDownload } from "@/lib/image-utils"
import { ZoomableImage, type ZoomableImageHandle } from "@/components/gallery/zoomable-image"
import { ZoomControls } from "@/components/gallery/zoom-controls"
import { MarkdownViewer } from "@/components/gallery/markdown-viewer"
import { HtmlViewer } from "@/components/gallery/html-viewer"
import { fetchTextContent } from "@/components/gallery/use-text-content"

export type GalleryItem =
  | { type: "image"; url: string; thumbnailUrl: string; filename: string; attachmentId: string }
  | { type: "video"; url: string; thumbnailUrl: string; filename: string; attachmentId: string }
  | { type: "markdown"; url: string; filename: string; attachmentId: string }
  | { type: "html"; url: string; filename: string; attachmentId: string }

const GALLERY_TYPE_LABELS: Record<GalleryItem["type"], string> = {
  image: "Image",
  video: "Video",
  markdown: "Markdown document",
  html: "HTML document",
}

// Sidebar thumbnails are 124px wide — long filenames (URLs, slugs with the
// extension at the tail) get unrecognizable when chopped from the end. Cut
// from the middle instead so both the leading word and the extension survive.
function truncateMiddle(filename: string, maxLength: number): string {
  if (filename.length <= maxLength) return filename
  const ellipsis = "…"
  const budget = maxLength - ellipsis.length
  const head = Math.ceil(budget / 2)
  const tail = Math.floor(budget / 2)
  return filename.slice(0, head) + ellipsis + filename.slice(-tail)
}

interface MediaGalleryProps {
  isOpen: boolean
  onClose: () => void
  items: GalleryItem[]
  initialIndex: number
  workspaceId: string
  /** Called when the user navigates to a different item. Used to sync the URL
   *  permalink and trigger lazy URL fetching for the newly-current item. */
  onItemChange?: (attachmentId: string) => void
}

function GalleryVideo({ current }: { current: Extract<GalleryItem, { type: "video" }> }) {
  const videoRef = useRef<HTMLVideoElement>(null)

  // Focus the video on mount/URL-ready so keyboard controls (space to play,
  // arrow keys for seek) work immediately. Without this the Dialog places
  // initial focus on the first focusable child (download button), which
  // steals space-bar toggling from the video.
  useEffect(() => {
    if (current.url) videoRef.current?.focus({ preventScroll: true })
  }, [current.url, current.attachmentId])

  return (
    <video
      ref={videoRef}
      key={current.attachmentId}
      src={current.url}
      poster={current.thumbnailUrl || undefined}
      controls
      controlsList="nodownload"
      tabIndex={-1}
      className="max-w-full max-h-full object-contain select-none outline-none"
    />
  )
}

interface GalleryMediaContentProps {
  current: GalleryItem
  isActive?: boolean
  /** Non-null only for the currently-displayed slide. When present with an image,
   *  the image is rendered via ZoomableImage so it can be zoomed/panned. */
  zoomableRef?: React.Ref<ZoomableImageHandle>
  onZoomChange?: (zoomed: boolean) => void
  onScaleChange?: (scale: number) => void
  /** Raw-source toggle; only consumed by markdown/html viewers. */
  rawMode?: boolean
}

function GalleryMediaContent({
  current,
  isActive = true,
  zoomableRef,
  onZoomChange,
  onScaleChange,
  rawMode = false,
}: GalleryMediaContentProps) {
  if (current.type === "markdown") {
    if (!isActive) {
      return (
        <div className="absolute inset-0 flex items-center justify-center">
          <FileText className="h-10 w-10 text-white/30" />
        </div>
      )
    }
    return <MarkdownViewer url={current.url} filename={current.filename} rawMode={rawMode} />
  }
  if (current.type === "html") {
    if (!isActive) {
      return (
        <div className="absolute inset-0 flex items-center justify-center">
          <Globe className="h-10 w-10 text-white/30" />
        </div>
      )
    }
    return <HtmlViewer url={current.url} filename={current.filename} rawMode={rawMode} />
  }
  if (current.type === "video") {
    // Non-active video slides show poster so the <video> element doesn't load
    if (!isActive) {
      return (
        <div className="absolute inset-0 flex items-center justify-center">
          {current.thumbnailUrl ? (
            <img
              src={current.thumbnailUrl}
              alt={current.filename}
              className="max-w-full max-h-full object-contain select-none"
              draggable={false}
            />
          ) : (
            <div className="h-16 w-16 rounded-full bg-white/10 backdrop-blur-sm flex items-center justify-center">
              <Play className="h-7 w-7 text-white/60 ml-0.5" fill="currentColor" />
            </div>
          )}
        </div>
      )
    }
    if (!current.url)
      return (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
          <div className="h-16 w-16 rounded-full bg-white/10 backdrop-blur-sm flex items-center justify-center">
            <Play className="h-7 w-7 text-white/60 ml-0.5" fill="currentColor" />
          </div>
          <Loader2 className="h-4 w-4 animate-spin text-white/40" />
        </div>
      )
    return (
      <div className="absolute inset-0 flex items-center justify-center">
        <GalleryVideo current={current} />
      </div>
    )
  }
  // While the full-resolution URL hasn't arrived yet, show the already-loaded
  // thumbnail as a poster instead of a blank loader — matches the video path
  // (poster while bytes stream in) and makes large-image opens feel instant.
  // Poster fills the container with object-contain (same sizing strategy as
  // the ZoomableImage poster fallback) so the swap into ZoomableImage when
  // the URL arrives is pixel-for-pixel — no "small thumbnail → filled image"
  // flash at the branch boundary.
  if (!current.url) {
    return (
      <div className="absolute inset-0">
        {current.thumbnailUrl && (
          <img
            src={current.thumbnailUrl}
            alt={current.filename}
            className="absolute inset-0 h-full w-full object-contain select-none"
            draggable={false}
          />
        )}
        <TopbarLoadingIndicator visible className="bottom-auto top-0" />
      </div>
    )
  }
  // Active image slide gets the zoomable viewport. Inactive slides stay as plain
  // <img> so we don't wire up gesture listeners for images the user isn't viewing.
  if (zoomableRef) {
    return (
      <ZoomableImage
        ref={zoomableRef}
        src={current.url}
        alt={current.filename}
        posterSrc={current.thumbnailUrl || undefined}
        onZoomChange={onZoomChange}
        onScaleChange={onScaleChange}
      />
    )
  }
  return (
    <div className="absolute inset-0 flex items-center justify-center">
      <img
        src={current.url}
        alt={current.filename}
        className="max-w-full max-h-full object-contain select-none"
        draggable={false}
      />
    </div>
  )
}

function GalleryThumbnailContent({ item }: { item: GalleryItem }) {
  if (item.type === "markdown" || item.type === "html") {
    const Icon = item.type === "markdown" ? FileText : Globe
    return (
      <div className="w-full h-20 min-w-0 flex flex-col items-center justify-center gap-1 bg-white/5 px-1">
        <Icon className="h-5 w-5 text-white/60" />
        <span className="block max-w-full overflow-hidden whitespace-nowrap text-[10px] text-white/50">
          {truncateMiddle(item.filename, 18)}
        </span>
      </div>
    )
  }
  if (item.type === "video") {
    if (!item.thumbnailUrl) {
      return (
        <div className="w-full h-20 flex items-center justify-center bg-gradient-to-br from-white/10 to-white/5">
          <div className="h-7 w-7 rounded-full bg-white/10 backdrop-blur-sm flex items-center justify-center">
            <Play className="h-3.5 w-3.5 text-white/60 ml-px" fill="currentColor" />
          </div>
        </div>
      )
    }
    return (
      <div className="relative w-full h-20 bg-black/40">
        <img
          src={item.thumbnailUrl}
          alt={item.filename}
          className="absolute inset-0 w-full h-full object-contain"
          loading="lazy"
          draggable={false}
        />
        <div className="absolute inset-0 flex items-center justify-center">
          <Play className="h-5 w-5 text-white drop-shadow-lg" fill="white" />
        </div>
      </div>
    )
  }
  // Prefer the already-loaded inline thumbnail URL for the sidebar so the panel
  // isn't full of spinners waiting for the full-resolution variant to lazy-fetch
  // on open. Fall back to full URL (if present) or a spinner.
  const sidebarSrc = item.thumbnailUrl || item.url
  if (!sidebarSrc) {
    return (
      <div className="w-full h-20 flex items-center justify-center bg-white/5">
        <Loader2 className="h-4 w-4 animate-spin text-white/40" />
      </div>
    )
  }
  return (
    <div className="relative w-full h-20 bg-black/40">
      <img
        src={sidebarSrc}
        alt={item.filename}
        className="absolute inset-0 w-full h-full object-contain"
        loading="lazy"
        draggable={false}
      />
    </div>
  )
}

export function MediaGallery({ isOpen, onClose, items, initialIndex, workspaceId, onItemChange }: MediaGalleryProps) {
  const [currentIndex, setCurrentIndex] = useState(initialIndex)
  const isMobile = useIsMobile()
  const [panelOpen, setPanelOpen] = useState(true)
  const [showArrows, setShowArrows] = useState(false)
  // Source vs. rendered toggle for markdown/html slides. Persists across
  // navigation within a session — if the user is reading raw markdown and
  // arrows over to the next markdown file, they probably want raw there too.
  const [rawMode, setRawMode] = useState(false)
  // containerWidth drives both slide sizing and strip transform calculations on mobile
  const [containerWidth, setContainerWidth] = useState(0)

  // Mobile strip refs — all DOM manipulation goes through these to avoid re-render jank
  const containerRef = useRef<HTMLDivElement | null>(null)
  const stripRef = useRef<HTMLDivElement | null>(null)
  const dismissWrapperRef = useRef<HTMLDivElement>(null)

  // Zoom/pan state for the current slide. Only reflects the active image.
  const zoomableRef = useRef<ZoomableImageHandle>(null)
  const [isZoomed, setIsZoomed] = useState(false)
  // Ref mirror so touch handlers (which avoid re-rendering during gestures) can
  // read the current zoom state without stale closures.
  const isZoomedRef = useRef(false)
  isZoomedRef.current = isZoomed

  // Pub/sub for scale so the percent display in ZoomControls can update at
  // 60fps during pinch without re-rendering this component (PR #384 pattern:
  // refs during gesture, React state only on commit).
  const scaleListenersRef = useRef<Set<(scale: number) => void>>(new Set())
  const publishScale = useCallback((scale: number) => {
    for (const cb of scaleListenersRef.current) cb(scale)
  }, [])
  const subscribeScale = useCallback((cb: (scale: number) => void) => {
    scaleListenersRef.current.add(cb)
    return () => {
      scaleListenersRef.current.delete(cb)
    }
  }, [])

  // Touch gesture state (all refs — no setState during active gesture)
  const touchStartX = useRef(0)
  const touchStartY = useRef(0)
  // Strip translateX at the moment the finger touches down (handles mid-animation starts)
  const touchStartStripX = useRef(0)
  const touchDeltaX = useRef(0)
  const touchDeltaY = useRef(0)
  const isSwiping = useRef(false)
  const swipeAxis = useRef<"x" | "y" | null>(null)
  const didSwipe = useRef(false)
  const lastTouchX = useRef(0)
  const lastTouchTime = useRef(0)
  const velocityX = useRef(0) // px/ms — used for flick-to-next even on short drags
  // When a touch starts inside the markdown/html panel we relinquish the
  // gesture entirely so native scroll can pan both axes (essential for wide
  // code blocks and tables). Carousel swipe/dismiss still work from the
  // surrounding gallery margin.
  const skipGesture = useRef(false)

  // Ref mirror of currentIndex so ResizeObserver can read it without stale closures
  const currentIndexRef = useRef(currentIndex)
  currentIndexRef.current = currentIndex

  const thumbnailRefs = useRef<Map<number, HTMLButtonElement>>(new Map())

  // Only sync currentIndex when the gallery opens — not on every initialIndex
  // change, which can shift due to late-loading images growing galleryImages.
  // A layout effect (not passive) so currentIndex is corrected synchronously
  // when isOpen flips, before Radix Presence's own layout effect mounts the
  // dialog content — that ordering guarantees the strip callback ref (below)
  // sees the opened item's index, not the previous one, on reopen.
  const prevOpen = useRef(false)
  const justOpened = useRef(false)
  useLayoutEffect(() => {
    if (isOpen && !prevOpen.current) {
      setCurrentIndex(initialIndex)
      justOpened.current = true
    }
    prevOpen.current = isOpen
  }, [isOpen, initialIndex])

  // Re-anchor currentIndex when the items array shifts underneath it.
  const viewedIdRef = useRef<string | null>(null)
  viewedIdRef.current = items[currentIndex]?.attachmentId ?? null
  useEffect(() => {
    if (justOpened.current) {
      justOpened.current = false
      return
    }
    if (!isOpen || !viewedIdRef.current) return
    setCurrentIndex((prev) => {
      const corrected = items.findIndex((i) => i.attachmentId === viewedIdRef.current)
      return corrected !== -1 && corrected !== prev ? corrected : prev
    })
  }, [items, isOpen])

  // Scroll active thumbnail into view when index changes
  useEffect(() => {
    const el = thumbnailRefs.current.get(currentIndex)
    el?.scrollIntoView({ block: "nearest", behavior: "smooth" })
  }, [currentIndex])

  // Measure the container and watch it for resize via a callback ref. Radix
  // Presence mounts the dialog content one render *after* `open` flips, so an
  // effect keyed on [isOpen] runs before the node exists and never re-fires to
  // pick up the late mount — leaving containerWidth at 0 and the strip stuck on
  // slide 0. A callback ref fires exactly on (re)mount, which is precisely when
  // the width becomes measurable.
  const roRef = useRef<ResizeObserver | null>(null)
  const setContainerNode = useCallback((node: HTMLDivElement | null) => {
    roRef.current?.disconnect()
    roRef.current = null
    containerRef.current = node
    if (!node) return
    if (node.offsetWidth > 0) setContainerWidth(node.offsetWidth)
    const ro = new ResizeObserver(([entry]) => {
      const w = entry.contentRect.width
      if (w <= 0) return
      setContainerWidth(w)
      if (stripRef.current) {
        stripRef.current.style.transition = "none"
        stripRef.current.style.transform = `translateX(${-currentIndexRef.current * w}px)`
      }
    })
    ro.observe(node)
    roRef.current = ro
  }, [])

  // Anchor the strip on the opened item the instant it mounts. currentIndex is
  // already synced to the opened item by the open-sync layout effect above
  // (which runs before Presence mounts this node), so currentIndexRef is fresh
  // here even on reopen. Width is read from the parent (the container) directly:
  // its DOM node exists in this commit even though setContainerNode's state
  // update hasn't been applied yet.
  const setStripNode = useCallback((node: HTMLDivElement | null) => {
    stripRef.current = node
    if (!node) return
    const w = node.parentElement?.offsetWidth ?? 0
    if (w <= 0) return
    setContainerWidth(w)
    node.style.transition = "none"
    node.style.transform = `translateX(${-currentIndexRef.current * w}px)`
  }, [])

  // Re-anchor when the gallery reopens without the content remounting (a close
  // interrupted by a fast reopen keeps the Presence node alive, so the callback
  // ref above doesn't re-fire) and when the width changes (rotation). Reads
  // currentIndexRef so an in-progress swipe animation isn't interrupted.
  useLayoutEffect(() => {
    if (!isMobile || containerWidth === 0 || !stripRef.current) return
    stripRef.current.style.transition = "none"
    stripRef.current.style.transform = `translateX(${-currentIndexRef.current * containerWidth}px)`
  }, [isOpen, isMobile, containerWidth])

  const current = items[currentIndex] ?? null
  const hasPrev = currentIndex > 0
  const hasNext = currentIndex < items.length - 1
  const isMultiple = items.length > 1

  const goTo = useCallback(
    (index: number) => {
      if (index < 0 || index >= items.length) return
      // Reset zoom on the outgoing slide so we never navigate with a stale transform;
      // the outgoing slide's hook will also reset when enabled flips to false, but
      // calling here lets the zoom-out animate in sync with the strip slide.
      zoomableRef.current?.reset()
      // On mobile, animate the strip directly before updating state so the
      // user sees a smooth slide rather than a hard cut.
      if (isMobile && stripRef.current && containerWidth > 0) {
        stripRef.current.style.transition = "transform 0.3s cubic-bezier(0.25, 0.46, 0.45, 0.94)"
        stripRef.current.style.transform = `translateX(${-index * containerWidth}px)`
      }
      setCurrentIndex(index)
      const next = items[index]
      if (next) onItemChange?.(next.attachmentId)
    },
    [items, onItemChange, isMobile, containerWidth]
  )

  const goPrev = useCallback(() => goTo(currentIndex - 1), [goTo, currentIndex])
  const goNext = useCallback(() => goTo(currentIndex + 1), [goTo, currentIndex])

  const handleDownload = useCallback(() => {
    if (!current) return
    downloadImage(workspaceId, current.attachmentId, current.filename)
  }, [workspaceId, current])

  const handleDownloadRaw = useCallback(async () => {
    if (!current || current.type !== "video") return
    try {
      const url = await attachmentsApi.getDownloadUrl(workspaceId, current.attachmentId, {
        download: true,
        variant: "raw",
      })
      triggerDownload(url, current.filename)
    } catch {
      // Download failed silently
    }
  }, [workspaceId, current])

  const handleDownloadProcessed = useCallback(async () => {
    if (!current || current.type !== "video") return
    try {
      const url = await attachmentsApi.getDownloadUrl(workspaceId, current.attachmentId, {
        download: true,
        variant: "processed",
      })
      triggerDownload(url, current.filename.replace(/\.[^.]+$/, ".mp4"))
    } catch {
      // Download failed silently
    }
  }, [workspaceId, current])

  const handleCopy = useCallback(async () => {
    if (!current?.url) return
    if (current.type === "image") {
      copyImage(current.url)
      return
    }
    if (current.type === "markdown" || current.type === "html") {
      try {
        const text = await fetchTextContent(current.url)
        await navigator.clipboard.writeText(text)
      } catch {
        // Clipboard or fetch failed; nothing actionable for the user here.
      }
    }
  }, [current])

  const canCopy = current?.type === "image" || current?.type === "markdown" || current?.type === "html"
  const canToggleRaw = current?.type === "markdown" || current?.type === "html"

  // Keyboard navigation
  useEffect(() => {
    if (!isOpen) return
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        e.preventDefault()
        goTo(currentIndex - 1)
      } else if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        e.preventDefault()
        goTo(currentIndex + 1)
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [isOpen, currentIndex, goTo])

  // ─── Mobile touch handlers ──────────────────────────────────────────────────
  // All handlers manipulate the DOM directly (no setState) so the gesture stays
  // at 60fps without React rendering in the hot path.

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    // The gallery owns every touch inside its Dialog. Stop React-tree bubbling
    // before any early return — React events propagate up the React tree (not
    // the DOM tree), so events from the Radix Portal still reach the message
    // row's swipe-to-quote and long-press handlers if we don't stop them here.
    e.stopPropagation()
    // When zoomed or pinching, the zoomable viewport owns the gesture — don't
    // start a carousel swipe in parallel (would cause the strip to drift while
    // the user is panning inside an image).
    if (isZoomedRef.current || e.touches.length > 1) return
    const target = e.target as HTMLElement | null
    if (target?.closest("[data-gallery-text-viewer]")) {
      // Yield to native scroll inside the text panel.
      skipGesture.current = true
      return
    }
    skipGesture.current = false
    // Read where the strip actually is right now (could be mid-animation)
    // so we can continue from that exact position rather than jumping.
    if (stripRef.current) {
      const matrix = new DOMMatrix(getComputedStyle(stripRef.current).transform)
      touchStartStripX.current = matrix.m41
      stripRef.current.style.transition = "none"
    }
    if (dismissWrapperRef.current) {
      dismissWrapperRef.current.style.transition = "none"
    }
    touchStartX.current = e.touches[0].clientX
    touchStartY.current = e.touches[0].clientY
    lastTouchX.current = e.touches[0].clientX
    lastTouchTime.current = Date.now()
    velocityX.current = 0
    touchDeltaX.current = 0
    touchDeltaY.current = 0
    isSwiping.current = false
    swipeAxis.current = null
  }, [])

  const handleTouchMove = useCallback(
    (e: React.TouchEvent) => {
      e.stopPropagation()
      if (skipGesture.current) return
      if (isZoomedRef.current || e.touches.length > 1) return
      const dx = e.touches[0].clientX - touchStartX.current
      const dy = e.touches[0].clientY - touchStartY.current
      touchDeltaX.current = dx
      touchDeltaY.current = dy

      // Rolling velocity — last frame's delta / elapsed ms
      const now = Date.now()
      const dt = now - lastTouchTime.current
      if (dt > 0) velocityX.current = (e.touches[0].clientX - lastTouchX.current) / dt
      lastTouchX.current = e.touches[0].clientX
      lastTouchTime.current = now

      if (!isSwiping.current && (Math.abs(dx) > 10 || Math.abs(dy) > 10)) {
        isSwiping.current = true
        swipeAxis.current = Math.abs(dx) >= Math.abs(dy) ? "x" : "y"
      }
      if (!isSwiping.current) return

      if (swipeAxis.current === "x") {
        if (!stripRef.current) return
        const atEdge = (dx > 0 && !hasPrev) || (dx < 0 && !hasNext)
        const effectiveDx = atEdge ? dx * 0.3 : dx
        // Move the entire strip — both images slide together seamlessly
        stripRef.current.style.transform = `translateX(${touchStartStripX.current + effectiveDx}px)`
      } else {
        if (!dismissWrapperRef.current) return
        // Vertical: drag down to dismiss; resist upward drags
        const effectiveDy = dy > 0 ? dy : dy * 0.1
        const opacity = Math.max(0.2, 1 - effectiveDy / 300)
        dismissWrapperRef.current.style.transform = `translateY(${effectiveDy}px)`
        dismissWrapperRef.current.style.opacity = String(opacity)
      }
    },
    [hasPrev, hasNext]
  )

  const handleTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      e.stopPropagation()
      if (skipGesture.current) {
        skipGesture.current = false
        return
      }
      if (isZoomedRef.current) return
      const dx = touchDeltaX.current
      const dy = touchDeltaY.current
      const vx = velocityX.current

      if (isSwiping.current) {
        if (swipeAxis.current === "x") {
          const w = containerRef.current?.offsetWidth ?? window.innerWidth
          // Either traveled far enough OR flicked fast enough
          const distThreshold = w * 0.25
          const velThreshold = 0.3 // px/ms

          const goingNext = (dx < -distThreshold || vx < -velThreshold) && hasNext
          const goingPrev = (dx > distThreshold || vx > velThreshold) && hasPrev
          let targetIndex = currentIndex
          if (goingNext) targetIndex = currentIndex + 1
          else if (goingPrev) targetIndex = currentIndex - 1

          if (stripRef.current) {
            stripRef.current.style.transition = "transform 0.3s cubic-bezier(0.25, 0.46, 0.45, 0.94)"
            stripRef.current.style.transform = `translateX(${-targetIndex * w}px)`
          }

          if (targetIndex !== currentIndex) {
            didSwipe.current = true
            setCurrentIndex(targetIndex)
            const next = items[targetIndex]
            if (next) onItemChange?.(next.attachmentId)
          } else {
            didSwipe.current = false
          }
        } else if (swipeAxis.current === "y") {
          if (dy > 80) {
            // Commit dismiss — slide off screen
            if (dismissWrapperRef.current) {
              dismissWrapperRef.current.style.transition = "transform 0.3s ease-out, opacity 0.3s ease-out"
              dismissWrapperRef.current.style.transform = `translateY(${window.innerHeight}px)`
              dismissWrapperRef.current.style.opacity = "0"
            }
            didSwipe.current = true
            setTimeout(() => onClose(), 300)
          } else {
            // Below threshold — spring back
            if (dismissWrapperRef.current) {
              dismissWrapperRef.current.style.transition = "transform 0.2s ease-out, opacity 0.2s ease-out"
              dismissWrapperRef.current.style.transform = ""
              dismissWrapperRef.current.style.opacity = "1"
            }
          }
        }
      }

      isSwiping.current = false
      swipeAxis.current = null
    },
    [currentIndex, hasNext, hasPrev, items, onItemChange, onClose]
  )

  // Mobile: tap left/right zones to navigate (suppressed after a committed swipe
  // and disabled while zoomed so taps inside a zoomed image don't navigate away).
  const handleMobileTap = useCallback(
    (e: React.MouseEvent) => {
      if (!isMobile || !isMultiple) return
      if (isZoomedRef.current) return
      // Tap-to-navigate inside the text panel would hijack link clicks, text
      // selection, and code-block interactions. Taps in the surrounding margin
      // still navigate — that's the only way to flip between text slides on
      // mobile once swipe is relinquished to native scroll.
      const target = e.target as HTMLElement | null
      if (target?.closest("[data-gallery-text-viewer]")) return
      if (didSwipe.current) {
        didSwipe.current = false
        return
      }
      const rect = e.currentTarget.getBoundingClientRect()
      const zone = (e.clientX - rect.left) / rect.width
      if (zone < 0.3 && hasPrev) goPrev()
      else if (zone > 0.7 && hasNext) goNext()
    },
    [isMobile, isMultiple, hasPrev, hasNext, goPrev, goNext]
  )

  const handleZoomIn = useCallback(() => zoomableRef.current?.zoomIn(), [])
  const handleZoomOut = useCallback(() => zoomableRef.current?.zoomOut(), [])
  const handleZoomReset = useCallback(() => zoomableRef.current?.reset(), [])

  // ─── Action bar (shared between mobile/desktop) ─────────────────────────────
  // Sits in a translucent dark pill so it stays readable against any backdrop
  // (image, video poster, markdown panel, sandboxed iframe). The text viewers
  // reserve their top inset (pt-14 / pt-16) so the pill never overlaps the
  // panel chrome; `top-3 right-3` gives the pill visible breathing room from
  // the screen edge instead of kissing it.
  const actionBar = (
    <div className="absolute top-3 right-3 z-10 flex items-center gap-1 rounded-full bg-black/55 px-1 py-0.5 shadow-lg backdrop-blur-sm">
      {!isMobile && current?.type === "image" && (
        <ZoomControls
          subscribeScale={subscribeScale}
          onZoomIn={handleZoomIn}
          onZoomOut={handleZoomOut}
          onReset={handleZoomReset}
          className="mr-1"
        />
      )}
      {isMultiple && (
        <span className="text-xs text-white/70 mr-1 tabular-nums">
          {currentIndex + 1} / {items.length}
        </span>
      )}
      {current?.type === "video" ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-10 w-10 text-white hover:bg-white/20 rounded-full">
              <Download className="h-5 w-5" />
              <span className="sr-only">Download video</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[160px]">
            <DropdownMenuItem onClick={handleDownloadProcessed}>Download processed</DropdownMenuItem>
            <DropdownMenuItem onClick={handleDownloadRaw}>Download original</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <>
          {canToggleRaw && (
            <Button
              variant="ghost"
              size="icon"
              className="h-10 w-10 text-white hover:bg-white/20 rounded-full"
              onClick={() => setRawMode((v) => !v)}
              aria-pressed={rawMode}
            >
              {rawMode ? <Eye className="h-5 w-5" /> : <Code2 className="h-5 w-5" />}
              <span className="sr-only">{rawMode ? "Show rendered preview" : "Show raw source"}</span>
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="h-10 w-10 text-white hover:bg-white/20 rounded-full"
            onClick={handleDownload}
          >
            <Download className="h-5 w-5" />
            <span className="sr-only">Download</span>
          </Button>
          {canCopy && (
            <Button
              variant="ghost"
              size="icon"
              className="h-10 w-10 text-white hover:bg-white/20 rounded-full"
              onClick={handleCopy}
            >
              <Copy className="h-5 w-5" />
              <span className="sr-only">{current?.type === "image" ? "Copy image" : "Copy source"}</span>
            </Button>
          )}
        </>
      )}
      {!isMobile && isMultiple && (
        <Button
          variant="ghost"
          size="icon"
          className="h-10 w-10 text-white hover:bg-white/20 rounded-full"
          onClick={() => setPanelOpen((v) => !v)}
        >
          {panelOpen ? <PanelRightClose className="h-5 w-5" /> : <PanelRightOpen className="h-5 w-5" />}
          <span className="sr-only">{panelOpen ? "Hide" : "Show"} preview panel</span>
        </Button>
      )}
      <Button
        variant="ghost"
        size="icon"
        className="h-10 w-10 text-white hover:bg-white/20 rounded-full"
        onClick={onClose}
      >
        <X className="h-5 w-5" />
        <span className="sr-only">Close</span>
      </Button>
    </div>
  )

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      {!current ? null : (
        <DialogContent
          className={cn(
            "p-0 max-sm:p-0 overflow-hidden bg-black/95 border-none",
            "max-sm:inset-auto max-sm:left-1/2 max-sm:top-1/2 max-sm:-translate-x-1/2 max-sm:-translate-y-1/2",
            "max-sm:max-w-[95vw] max-sm:h-[90vh] max-sm:rounded-lg",
            isMobile ? "max-w-[95vw] h-[90vh]" : "max-w-[90vw] h-[90vh]"
          )}
          hideCloseButton
        >
          <DialogTitle className="sr-only">{current.filename}</DialogTitle>
          <DialogDescription className="sr-only">
            {GALLERY_TYPE_LABELS[current.type]} {currentIndex + 1} of {items.length}
          </DialogDescription>

          <div className="relative flex h-full overflow-hidden">
            {isMobile ? (
              // ── Mobile: seamless horizontal strip carousel ────────────────
              // dismissWrapperRef handles the vertical "drag down to close" gesture.
              // containerRef clips the strip; stripRef holds all slides side-by-side
              // and moves as one unit so the entering image slides in simultaneously
              // with the exiting one — matching velocity and direction.
              <div ref={dismissWrapperRef} className="relative flex-1 min-w-0 min-h-0">
                {actionBar}

                <div
                  ref={setContainerNode}
                  className="absolute inset-0 overflow-hidden"
                  onTouchStart={handleTouchStart}
                  onTouchMove={handleTouchMove}
                  onTouchEnd={handleTouchEnd}
                  onClick={handleMobileTap}
                >
                  {/* Strip: all slides laid out horizontally; transform moves them as one */}
                  <div ref={setStripNode} className="flex h-full" style={{ willChange: "transform" }}>
                    {items.map((item, i) => (
                      <div
                        key={item.attachmentId}
                        className="shrink-0 relative"
                        style={{ width: containerWidth || "100%", height: "100%" }}
                      >
                        <GalleryMediaContent
                          current={item}
                          isActive={Math.abs(i - currentIndex) <= 1}
                          zoomableRef={i === currentIndex && item.type === "image" ? zoomableRef : undefined}
                          onZoomChange={i === currentIndex && item.type === "image" ? setIsZoomed : undefined}
                          onScaleChange={i === currentIndex && item.type === "image" ? publishScale : undefined}
                          rawMode={i === currentIndex ? rawMode : false}
                        />
                      </div>
                    ))}
                  </div>
                </div>

                {/* Filename bar sits above the strip so it doesn't scroll with it */}
                <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent p-4 pointer-events-none z-10">
                  <span className="text-sm text-white">{current.filename}</span>
                </div>
              </div>
            ) : (
              // ── Desktop: single-image view with hover arrows ──────────────
              <div
                className="relative flex-1 min-w-0 min-h-0 flex items-center justify-center"
                onMouseEnter={() => setShowArrows(true)}
                onMouseLeave={() => setShowArrows(false)}
              >
                {actionBar}

                <div className="absolute inset-0">
                  <GalleryMediaContent
                    current={current}
                    zoomableRef={current.type === "image" ? zoomableRef : undefined}
                    onZoomChange={current.type === "image" ? setIsZoomed : undefined}
                    onScaleChange={current.type === "image" ? publishScale : undefined}
                    rawMode={rawMode}
                  />
                </div>

                {isMultiple && (
                  <>
                    <button
                      type="button"
                      className={cn(
                        "absolute left-2 top-1/2 -translate-y-1/2 z-10",
                        "h-10 w-10 rounded-full bg-black/50 flex items-center justify-center",
                        "text-white hover:bg-black/70 transition-opacity duration-200",
                        !hasPrev && "invisible",
                        showArrows ? "opacity-100" : "opacity-0"
                      )}
                      onClick={goPrev}
                      aria-label="Previous"
                    >
                      <ChevronLeft className="h-6 w-6" />
                    </button>
                    <button
                      type="button"
                      className={cn(
                        "absolute right-2 top-1/2 -translate-y-1/2 z-10",
                        "h-10 w-10 rounded-full bg-black/50 flex items-center justify-center",
                        "text-white hover:bg-black/70 transition-opacity duration-200",
                        !hasNext && "invisible",
                        showArrows ? "opacity-100" : "opacity-0"
                      )}
                      onClick={goNext}
                      aria-label="Next"
                    >
                      <ChevronRight className="h-6 w-6" />
                    </button>
                  </>
                )}

                <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent p-4">
                  <span className="text-sm text-white">{current.filename}</span>
                </div>
              </div>
            )}

            {/* Desktop: thumbnail preview panel */}
            {!isMobile && isMultiple && panelOpen && (
              <div className="w-[140px] shrink-0 border-l border-white/10 bg-black/80 flex flex-col">
                <ScrollArea className="flex-1">
                  <TooltipProvider delayDuration={400}>
                    <div className="flex flex-col gap-1.5 p-2">
                      {items.map((item, i) => (
                        <Tooltip key={item.attachmentId}>
                          <TooltipTrigger asChild>
                            <button
                              ref={(el) => {
                                if (el) thumbnailRefs.current.set(i, el)
                                else thumbnailRefs.current.delete(i)
                              }}
                              type="button"
                              className={cn(
                                "relative w-full rounded overflow-hidden border-2 transition-all",
                                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
                                i === currentIndex
                                  ? "border-white opacity-100"
                                  : "border-transparent opacity-50 hover:opacity-80"
                              )}
                              onClick={() => goTo(i)}
                              aria-label={`View ${item.filename}`}
                              aria-current={i === currentIndex ? "true" : undefined}
                            >
                              <GalleryThumbnailContent item={item} />
                            </button>
                          </TooltipTrigger>
                          <TooltipContent side="left" className="max-w-[260px] break-all">
                            {item.filename}
                          </TooltipContent>
                        </Tooltip>
                      ))}
                    </div>
                  </TooltipProvider>
                </ScrollArea>
              </div>
            )}
          </div>
        </DialogContent>
      )}
    </Dialog>
  )
}
