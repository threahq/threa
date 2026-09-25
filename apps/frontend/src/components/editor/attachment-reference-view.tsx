import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react"
import { attachmentReferenceLabel } from "@threahq/prosemirror"
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip"
import { AttachmentChip } from "@/components/timeline/attachment-chip"
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
  return attachmentReferenceLabel(attrs)
}

export function AttachmentReferenceView({ node }: NodeViewProps) {
  const attrs = node.attrs as AttachmentReferenceAttrs
  const isImage = attrs.mimeType.startsWith("image/")
  const status = attrs.status === "uploaded" ? "ready" : attrs.status

  const content = (
    <NodeViewWrapper as="span" data-type="attachment-reference">
      <AttachmentChip label={getDisplayText(attrs)} mimeType={attrs.mimeType} status={status} />
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
