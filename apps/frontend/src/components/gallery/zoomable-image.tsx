import { forwardRef, useImperativeHandle, useRef, useState } from "react"
import { TopbarLoadingIndicator } from "@/components/layout/topbar-loading-indicator"
import { useZoomPan } from "@/hooks/use-zoom-pan"
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
            "pointer-events-none absolute inset-0 h-full w-full object-contain select-none transition-opacity duration-200",
            decoded ? "opacity-0" : "opacity-100"
          )}
          draggable={false}
        />
      )}
      <img
        ref={imgRef}
        src={src}
        alt={alt}
        onLoad={() => setLoadedSrc(src)}
        className={cn(
          "max-w-full max-h-full object-contain select-none transition-opacity duration-200",
          decoded ? "opacity-100" : "opacity-0"
        )}
        draggable={false}
        style={{ willChange: "transform" }}
      />
      <TopbarLoadingIndicator visible={!decoded} className="bottom-auto top-0" />
    </div>
  )
})
