import { type ReactNode } from "react"
import { AlertCircle, FileIcon, ImageIcon, Loader2 } from "lucide-react"
import { cn } from "@/lib/utils"

export type AttachmentChipStatus = "uploaded" | "uploading" | "pending" | "error"

const STATUS_STYLES: Record<AttachmentChipStatus, string> = {
  uploaded: cn(
    "bg-primary/10 text-primary hover:bg-primary/20",
    "dark:bg-primary/20 dark:text-primary dark:hover:bg-primary/30"
  ),
  uploading: "bg-muted/50 text-muted-foreground animate-pulse",
  pending: "bg-muted/50 text-muted-foreground cursor-default",
  error: "bg-destructive/10 text-destructive hover:bg-destructive/20",
}

/**
 * Presentational inline attachment chip shared by the composer NodeView
 * (`AttachmentReferenceView`) and the timeline markdown renderer
 * (`MarkdownLink`'s `attachment:` branch), so a reference reads the same
 * before and after it is sent.
 */
export function AttachmentChip({
  label,
  mimeType,
  status = "uploaded",
  className,
}: {
  label: ReactNode
  mimeType?: string
  status?: AttachmentChipStatus
  className?: string
}) {
  let Icon = mimeType?.startsWith("image/") ? ImageIcon : FileIcon
  if (status === "uploading") Icon = Loader2
  else if (status === "error") Icon = AlertCircle

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded px-1.5 py-0.5 align-baseline text-sm",
        "cursor-pointer transition-colors",
        STATUS_STYLES[status],
        className
      )}
    >
      <Icon className={cn("h-3.5 w-3.5 shrink-0", status === "uploading" && "animate-spin")} aria-hidden="true" />
      <span className="truncate max-w-[150px]">[{label}]</span>
    </span>
  )
}
