import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react"
import { Loader2, FileIcon, AlertCircle, ImageIcon } from "lucide-react"
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import type { AttachmentReferenceAttrs } from "./attachment-reference-extension"

function formatFileSize(bytes: number | null): string {
  if (bytes == null) return "Size unavailable"
  if (bytes === 0) return "0 B"
  const k = 1024
  const sizes = ["B", "KB", "MB", "GB"]
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`
}

function getDisplayText(attrs: AttachmentReferenceAttrs): string {
  if (attrs.status === "uploading") {
    return "Uploading..."
  }
  if (attrs.status === "error") {
    return "Upload failed"
  }
  const isImage = attrs.mimeType.startsWith("image/")
  if (isImage && attrs.imageIndex) {
    return `Image #${attrs.imageIndex}`
  }
  return attrs.filename
}

export function AttachmentReferenceView({ node }: NodeViewProps) {
  const attrs = node.attrs as AttachmentReferenceAttrs
  const isImage = attrs.mimeType.startsWith("image/")
  const displayText = getDisplayText(attrs)

  let Icon = FileIcon
  if (attrs.status === "uploading") {
    Icon = Loader2
  } else if (attrs.status === "error") {
    Icon = AlertCircle
  } else if (isImage) {
    Icon = ImageIcon
  }

  const baseStyles = cn(
    "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-sm",
    "cursor-pointer select-none transition-colors"
  )

  const statusStyles = {
    uploading: "bg-muted/50 text-muted-foreground animate-pulse",
    uploaded: cn(
      "bg-primary/10 text-primary hover:bg-primary/20",
      "dark:bg-primary/20 dark:text-primary dark:hover:bg-primary/30"
    ),
    error: "bg-destructive/10 text-destructive hover:bg-destructive/20",
  }

  const handleClick = () => {
    if (attrs.status !== "uploaded") return
  }

  const content = (
    <NodeViewWrapper
      as="span"
      className={cn(baseStyles, statusStyles[attrs.status])}
      onClick={handleClick}
      data-type="attachment-reference"
    >
      <Icon className={cn("h-3.5 w-3.5 shrink-0", attrs.status === "uploading" && "animate-spin")} />
      <span className="truncate max-w-[150px]">[{displayText}]</span>
    </NodeViewWrapper>
  )

  if (attrs.status === "uploading") {
    return content
  }

  if (attrs.status === "error") {
    return (
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <TooltipTrigger asChild>{content}</TooltipTrigger>
          <TooltipContent side="top" className="max-w-[200px]">
            <p className="text-sm">{attrs.error || "Upload failed"}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    )
  }

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>{content}</TooltipTrigger>
        <TooltipContent side="top" className="max-w-[250px]">
          <div className="space-y-1">
            <p className="text-sm font-medium truncate">{attrs.filename}</p>
            <p className="text-xs text-muted-foreground">{formatFileSize(attrs.sizeBytes)}</p>
            {isImage && <p className="text-xs text-muted-foreground">Click to view full size</p>}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
