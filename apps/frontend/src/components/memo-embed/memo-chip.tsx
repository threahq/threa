import { type ReactNode } from "react"
import { BookOpen } from "lucide-react"
import { cn } from "@/lib/utils"

/**
 * Presentational inline memo chip shared by both surfaces that render a memo
 * reference inline: the composer NodeView (`MemoEmbedView`) and the timeline
 * markdown renderer (`MarkdownLink`'s `memo:` branch). The hydrated preview
 * card renders separately below the message (`MemoPreviewList`).
 */
export function MemoChip({ label, className }: { label: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded px-1.5 py-0.5 align-baseline text-sm",
        "bg-primary/10 font-medium text-primary [&_*]:[text-decoration:inherit]",
        className
      )}
      data-type="memo-chip"
    >
      <BookOpen className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span className="max-w-[14rem] truncate">{label}</span>
    </span>
  )
}
