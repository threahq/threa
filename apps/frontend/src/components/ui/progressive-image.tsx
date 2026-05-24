import { useState } from "react"
import { cn } from "@/lib/utils"

export interface ProgressiveImageProps {
  /** Full-resolution image URL. Pass null while the URL is still being
   *  fetched; the poster (if any) will be shown alone until `src` arrives. */
  src: string | null
  /** Low-resolution poster shown until the full-resolution image decodes.
   *  Must share `src`'s aspect ratio — the crossfade depends on both layers
   *  rendering at the same pixel bounds. */
  posterSrc?: string | null
  alt: string
  /** object-fit policy applied to both layers. */
  fit?: "contain" | "cover"
  /** Class applied to the `relative inline-block` wrapper that hosts the two
   *  image layers (only used when both poster and full-res are present). */
  className?: string
  /** Class applied to both `<img>` elements. Set sizing constraints here
   *  (`max-h-[50vh] max-w-full`, fixed dimensions, etc.) — the poster uses
   *  them to establish the wrapper's natural size and the full-res layer
   *  inherits the same box via `absolute inset-0`. */
  imgClassName?: string
}

/**
 * Crossfades from a low-resolution poster to a full-resolution image so heavy
 * originals don't show a blank box during decode.
 *
 * Layering: the poster `<img>` is inline (block) and establishes the wrapper's
 * dimensions; the full-res `<img>` is absolutely positioned to fill the same
 * box. Because both share the same aspect ratio and `object-fit`, they paint
 * at identical pixel bounds — the crossfade is a true overlap, never a resize.
 *
 * Tracks `loadedSrc === src` instead of a boolean so a `src` change auto-resets
 * the decoded state without a separate effect — the moment a new src is set,
 * `decoded` flips false until the new image's onLoad fires.
 *
 * Originally lifted from the gallery's `ZoomableImage` poster pattern
 * (PR #612). Use anywhere you have a small variant ready while a larger one
 * is still in flight.
 */
export function ProgressiveImage({
  src,
  posterSrc,
  alt,
  fit = "contain",
  className,
  imgClassName,
}: ProgressiveImageProps) {
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null)
  const decoded = !!src && loadedSrc === src

  const fitClass = fit === "contain" ? "object-contain" : "object-cover"

  if (!posterSrc) {
    if (!src) return null
    return (
      <img
        src={src}
        alt={alt}
        onLoad={() => setLoadedSrc(src)}
        className={cn(fitClass, imgClassName)}
        draggable={false}
      />
    )
  }

  if (!src) {
    return <img src={posterSrc} alt={alt} className={cn(fitClass, imgClassName)} draggable={false} />
  }

  return (
    <div className={cn("relative inline-block", className)}>
      <img
        src={posterSrc}
        alt=""
        aria-hidden
        className={cn(
          "block transition-opacity duration-200",
          fitClass,
          decoded ? "opacity-0" : "opacity-100",
          imgClassName
        )}
        draggable={false}
      />
      <img
        src={src}
        alt={alt}
        onLoad={() => setLoadedSrc(src)}
        className={cn(
          "absolute inset-0 h-full w-full transition-opacity duration-200",
          fitClass,
          decoded ? "opacity-100" : "opacity-0",
          imgClassName
        )}
        draggable={false}
      />
    </div>
  )
}
