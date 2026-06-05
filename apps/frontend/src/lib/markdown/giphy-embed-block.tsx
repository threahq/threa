import { GiphyImage } from "@/components/giphy/giphy-image"
import { cn } from "@/lib/utils"

interface GiphyEmbedBlockProps {
  giphyUrl: string
  /** Pre-render label parsed from the markdown link text. */
  title: string
}

/**
 * Renders a GIF preview card below a message — one per `giphy:` reference in the
 * body, stacked like attachment and memo previews. The inline `giphy:` chip
 * stays in the rendered markdown; this surfaces the actual GIF (from Giphy's
 * CDN), highlighted on hover the way attachment cards are.
 */
export function GiphyEmbedBlock({ giphyUrl, title }: GiphyEmbedBlockProps) {
  return (
    <div
      className={cn(
        "inline-block rounded-md border border-border bg-card p-1",
        "transition-colors hover:border-primary/70 hover:bg-primary/[0.04]"
      )}
      data-type="giphy-embed"
    >
      <GiphyImage url={giphyUrl} title={title} />
    </div>
  )
}
