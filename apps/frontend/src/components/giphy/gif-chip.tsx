import { type ReactNode } from "react"
import { Film } from "lucide-react"
import { cn } from "@/lib/utils"

/**
 * Presentational inline GIF chip shared by the composer NodeView
 * (`GiphyEmbedView`) and the timeline markdown renderer (`MarkdownLink`'s
 * `giphy:` branch). The GIF itself renders separately below the message
 * (`GiphyPreviewList`), the same way memo cards and attachments do — so the
 * inline body stays text-like instead of embedding media mid-sentence.
 */
export function GifChip({ label, className }: { label: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded px-1.5 py-0.5 align-baseline text-sm",
        "bg-primary/10 font-medium text-primary [&_*]:[text-decoration:inherit]",
        className
      )}
      data-type="gif-chip"
    >
      <Film className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span className="max-w-[14rem] truncate">{label}</span>
    </span>
  )
}
