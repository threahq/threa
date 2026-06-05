import { cn } from "@/lib/utils"

interface GiphyImageProps {
  /** Giphy CDN URL of the GIF to render. */
  url: string
  title?: string
  className?: string
}

/**
 * Renders a GIF straight from Giphy's CDN with the required GIPHY attribution
 * mark. Shared by the composer node view and the timeline renderer so the embed
 * looks the same wherever it appears.
 */
export function GiphyImage({ url, title, className }: GiphyImageProps) {
  return (
    <span className={cn("relative inline-block max-w-full align-bottom", className)} data-type="giphy-embed">
      <img src={url} alt={title || "GIF"} loading="lazy" className="block max-h-60 max-w-full rounded" />
      <span className="pointer-events-none absolute bottom-1 right-1 rounded bg-black/55 px-1 text-[9px] font-semibold uppercase tracking-wide text-white/90">
        GIPHY
      </span>
    </span>
  )
}
