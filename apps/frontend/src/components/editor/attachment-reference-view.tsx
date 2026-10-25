import { useState, type ReactNode } from "react"
import { useParams } from "react-router-dom"
import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react"
import { attachmentReferenceLabel } from "@threahq/prosemirror"
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Button } from "@/components/ui/button"
import { AttachmentChip } from "@/components/timeline/attachment-chip"
import { ThumbnailImg, thumbnailBox, useThumbnailLoadState } from "@/components/timeline/attachment-thumbnail"
import { attachmentContentUrl } from "@/api"
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

function InlineImage({
  workspaceId,
  attachmentId,
  filename,
}: {
  workspaceId: string
  attachmentId: string
  filename: string
}) {
  const load = useThumbnailLoadState()
  const box = thumbnailBox()
  return (
    <span
      style={{ width: box.width, height: box.height }}
      className="relative inline-block align-top overflow-hidden rounded-lg border bg-muted/30"
    >
      {!load.decoded && <span className="absolute inset-0 animate-pulse bg-muted" />}
      <ThumbnailImg
        src={attachmentContentUrl(workspaceId, attachmentId, { variant: "thumbnail" })}
        alt={filename}
        load={load}
      />
    </span>
  )
}

function ImageDisplayToggle({
  attrs,
  updateAttributes,
  children,
}: {
  attrs: AttachmentReferenceAttrs
  updateAttributes: NodeViewProps["updateAttributes"]
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const inline = attrs.display === "inline"
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" aria-label={attrs.filename} className="inline cursor-pointer align-baseline">
          {children}
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" className="w-auto p-1">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            updateAttributes({ display: inline ? "pill" : "inline" })
            setOpen(false)
          }}
        >
          {inline ? "Show as chip" : "Show as image"}
        </Button>
      </PopoverContent>
    </Popover>
  )
}

export function AttachmentReferenceView({ node, updateAttributes }: NodeViewProps) {
  const attrs = node.attrs as AttachmentReferenceAttrs
  const { workspaceId } = useParams<{ workspaceId: string }>()
  const isImage = attrs.mimeType.startsWith("image/")
  const showInline = isImage && attrs.display === "inline" && attrs.status === "uploaded" && workspaceId

  const visual = showInline ? (
    <InlineImage workspaceId={workspaceId} attachmentId={attrs.id} filename={attrs.filename} />
  ) : (
    <AttachmentChip label={getDisplayText(attrs)} mimeType={attrs.mimeType} status={attrs.status} />
  )

  const content = (
    <NodeViewWrapper as="span" data-type="attachment-reference">
      {isImage ? (
        <ImageDisplayToggle attrs={attrs} updateAttributes={updateAttributes}>
          {visual}
        </ImageDisplayToggle>
      ) : (
        visual
      )}
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
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
