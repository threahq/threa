import { type ComponentType, type ReactNode } from "react"
import { Link2 } from "lucide-react"
import { cn } from "@/lib/utils"

/**
 * Presentational inline chip for an in-app stream/message link, shared by the
 * composer NodeView (`InAppLinkView`) and the timeline markdown renderer
 * (`MarkdownLink`'s in-app branch) — the same split `MemoChip` uses. Compact so
 * it reads as a single token in the message body instead of a raw URL.
 */
export function InAppLinkChip({
  icon: Icon,
  label,
  className,
}: {
  icon?: ComponentType<{ className?: string }>
  label: ReactNode
  className?: string
}) {
  const ChipIcon = Icon ?? Link2
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded px-1.5 py-0.5 align-baseline text-sm",
        "bg-primary/10 font-medium text-primary [&_*]:[text-decoration:inherit]",
        className
      )}
      data-type="in-app-link-chip"
    >
      <ChipIcon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span className="max-w-[14rem] truncate">{label}</span>
    </span>
  )
}
