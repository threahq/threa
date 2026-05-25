import { useState } from "react"
import { cn } from "@/lib/utils"

export interface ProgressiveImageProps {
  /** Full-resolution image URL. Pass null while the URL is still being
   *  fetched; the poster (if any) is shown alone until `src` arrives. */
  src: string | null
  /** Low-resolution poster shown until the full-resolution image decodes.
   *  Must share `src`'s aspect ratio — the crossfade depends on both layers
   *  rendering at the same pixel bounds. */
  posterSrc?: string | null
  alt: string
  /** Class applied to the size-determining `<img>` — the poster when one is
   *  present, otherwise the full-res. Use this for sizing constraints
   *  (`max-h-[50vh] max-w-full`, fixed dimensions, etc.). */
  imgClassName?: string
}

/**
 * Crossfades from a low-resolution poster to a full-resolution image so heavy
 * originals don't show a blank box during decode.
 *
 * The poster `<img>` is inline (block) and establishes the wrapper's
 * dimensions. The full-res `<img>` is absolutely positioned over it. Because
 * both share the source's aspect ratio and `object-contain`, they paint at
 * identical pixel bounds — the crossfade is a true overlap, never a resize.
 * If a caller needs `object-cover`, pass it via `imgClassName` — `twMerge`
 * lets it win over the default.
 *
 * The wrapper renders whenever `posterSrc` is set, even before `src` arrives,
 * so the poster `<img>` keeps the same DOM identity across the
 * `src: null → string` transition. Without that, React would unmount a bare
 * poster `<img>` and mount the two-layer subtree when the full-res URL lands —
 * destroying the already-loaded poster and flashing blank exactly when the
 * crossfade should begin.
 *
 * `loadedSrc === src` (instead of a boolean) auto-resets the decoded state
 * when `src` changes — no separate effect needed. A stale `onLoad` from a
 * previous src writes the previous URL into `loadedSrc`, which still compares
 * unequal to the new `src`, so `decoded` stays false until the new image's
 * own `onLoad` fires.
 */
export function ProgressiveImage({ src, posterSrc, alt, imgClassName }: ProgressiveImageProps) {
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null)
  const decoded = !!src && loadedSrc === src

  if (!posterSrc) {
    if (!src) return null
    return (
      <img
        src={src}
        alt={alt}
        onLoad={() => setLoadedSrc(src)}
        className={cn("object-contain", imgClassName)}
        draggable={false}
      />
    )
  }

  return (
    <div className="relative inline-block">
      <img
        src={posterSrc}
        alt={src ? "" : alt}
        aria-hidden={src ? true : undefined}
        className={cn(
          "block object-contain transition-opacity duration-200",
          decoded ? "opacity-0" : "opacity-100",
          imgClassName
        )}
        draggable={false}
      />
      {src && (
        <img
          src={src}
          alt={alt}
          onLoad={() => setLoadedSrc(src)}
          className={cn(
            "absolute inset-0 h-full w-full object-contain transition-opacity duration-200",
            decoded ? "opacity-100" : "opacity-0"
          )}
          draggable={false}
        />
      )}
    </div>
  )
}
