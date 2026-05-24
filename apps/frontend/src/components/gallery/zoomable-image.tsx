import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react"
import { TopbarLoadingIndicator } from "@/components/layout/topbar-loading-indicator"
import { fitContain, useZoomPan } from "@/hooks/use-zoom-pan"
import { cn } from "@/lib/utils"

export interface ZoomableImageHandle {
  reset: () => void
  zoomIn: () => void
  zoomOut: () => void
}

interface ZoomableImageProps {
  src: string
  alt: string
  /** Low-resolution thumbnail to show underneath while the full-resolution
   *  image decodes. Heavy originals can take several seconds to paint after
   *  `src` lands; without a poster the viewport is blank between "src set"
   *  and "bytes painted", which reads as the gallery being stuck. */
  posterSrc?: string
  onZoomChange?: (zoomed: boolean) => void
  /** Fires synchronously on every scale change (including 60fps during pinch).
   *  Subscribers should be self-contained — using this to drive parent state
   *  defeats the ref-based fanout pattern. */
  onScaleChange?: (scale: number) => void
}

export const ZoomableImage = forwardRef<ZoomableImageHandle, ZoomableImageProps>(function ZoomableImage(
  { src, alt, posterSrc, onZoomChange, onScaleChange },
  ref
) {
  const containerRef = useRef<HTMLDivElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  // Track which src has actually painted. Comparing to the prop instead of
  // a boolean handles src changes without a separate reset effect — the
  // moment a new src lands, decoded flips false until the new image's
  // onLoad fires.
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null)
  const decoded = loadedSrc === src

  // Compute the exact object-contain bounds ourselves so the poster and the
  // main image render at identical pixel sizes during the crossfade. Without
  // this the poster (forced to container size) and the main image (sized to
  // natural with max-w/h caps) lay out differently for any image smaller
  // than the viewport, producing a visible size jump between frames.
  const [containerSize, setContainerSize] = useState({ w: 0, h: 0 })
  const [naturalDims, setNaturalDims] = useState<{ w: number; h: number } | null>(null)

  // Reset measured dims when src changes so the new image gets its own bounds
  // — leaving stale dims in place flashes the previous image's aspect.
  useEffect(() => {
    setNaturalDims(null)
  }, [src])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const measure = () => setContainerSize({ w: container.clientWidth, h: container.clientHeight })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(container)
    return () => ro.disconnect()
  }, [])

  const rendered =
    naturalDims && containerSize.w > 0 && containerSize.h > 0
      ? fitContain(naturalDims.w, naturalDims.h, containerSize.w, containerSize.h)
      : null

  // Style applied to BOTH the poster and the main image so they cross-fade at
  // identical dimensions and overlap pixel-for-pixel. `inset: 0; margin: auto`
  // centers absolute children inside the container without flex (flex would
  // stack siblings instead of overlapping them). The fallback (before we've
  // measured naturalDims) fills the container so object-contain handles
  // sizing — that way the switch to explicit rendered dims is a no-op, not
  // a visible jump from "natural size, centered" to "filled".
  const imageBoxStyle: React.CSSProperties = rendered
    ? { position: "absolute", inset: 0, margin: "auto", width: rendered.w, height: rendered.h }
    : { position: "absolute", inset: 0, width: "100%", height: "100%" }

  const captureNatural = (img: HTMLImageElement) => {
    if (img.naturalWidth > 0 && img.naturalHeight > 0) {
      setNaturalDims({ w: img.naturalWidth, h: img.naturalHeight })
    }
  }

  const { isZoomed, zoomIn, zoomOut, reset } = useZoomPan({
    containerRef,
    contentRef: imgRef,
    onZoomChange,
    onScaleChange,
  })

  useImperativeHandle(
    ref,
    () => ({
      reset: () => reset({ transition: true }),
      zoomIn,
      zoomOut,
    }),
    [reset, zoomIn, zoomOut]
  )

  // Shimmer sits along the top edge of the rendered image bounds (not the
  // modal). Wrapper is absolutely positioned so toggling visibility never
  // shifts layout, and the inner indicator uses `top-0` to anchor to the
  // top of that wrapper instead of the bottom default.
  const shimmerStyle: React.CSSProperties = rendered
    ? {
        top: (containerSize.h - rendered.h) / 2,
        left: (containerSize.w - rendered.w) / 2,
        width: rendered.w,
      }
    : { top: 0, left: 0, right: 0 }

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 flex items-center justify-center overflow-hidden"
      style={{
        // Disable browser pinch-zoom / scroll gestures inside the viewport so our
        // custom handlers own the input. Double-tap-to-zoom is handled manually.
        touchAction: "none",
        cursor: isZoomed ? "grab" : "default",
        userSelect: "none",
      }}
    >
      {posterSrc && (
        <img
          src={posterSrc}
          alt=""
          aria-hidden
          className={cn(
            "pointer-events-none absolute object-contain select-none transition-opacity duration-200",
            decoded ? "opacity-0" : "opacity-100"
          )}
          style={imageBoxStyle}
          onLoad={(event) => captureNatural(event.currentTarget)}
          draggable={false}
        />
      )}
      <img
        ref={imgRef}
        src={src}
        alt={alt}
        onLoad={(event) => {
          captureNatural(event.currentTarget)
          setLoadedSrc(src)
        }}
        className={cn(
          "object-contain select-none transition-opacity duration-200",
          decoded ? "opacity-100" : "opacity-0"
        )}
        draggable={false}
        style={{ ...imageBoxStyle, willChange: "transform" }}
      />
      <div className="pointer-events-none absolute" style={shimmerStyle}>
        <TopbarLoadingIndicator visible={!decoded} className="bottom-auto top-0" />
      </div>
    </div>
  )
})
