import { useRef, useState, type ReactNode } from "react"
import { useParams } from "react-router-dom"
import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react"
import { attachmentReferenceLabel } from "@threahq/prosemirror"
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Button } from "@/components/ui/button"
import { AttachmentChip } from "@/components/timeline/attachment-chip"
import { ThumbnailImg, thumbnailBox, useThumbnailLoadState } from "@/components/timeline/attachment-thumbnail"
import { attachmentContentUrl } from "@/api"
import { getUploadJobByAttachmentId } from "@/lib/uploads/upload-manager"
import {
  DISPLAY_TOGGLE_LABEL,
  imageReferenceDisplay,
  toggledDisplay,
  type AttachmentDisplay,
  type AttachmentReferenceAttrs,
} from "./attachment-reference-extension"

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
  // The id is reserved before the bytes land, so the server thumbnail can 404
  // mid-upload; the job's local preview lives until the composer releases it.
  const src =
    getUploadJobByAttachmentId(attachmentId)?.previewUrl ??
    attachmentContentUrl(workspaceId, attachmentId, { variant: "thumbnail" })
  return (
    <span
      style={{ width: box.width, height: box.height }}
      className="relative inline-block align-top overflow-hidden rounded-lg border bg-muted/30"
    >
      {load.error ? (
        <span className="absolute inset-0 flex items-center justify-center p-2 text-center text-xs text-muted-foreground">
          Image unavailable
        </span>
      ) : (
        <>
          {!load.decoded && <span className="absolute inset-0 animate-pulse bg-muted" />}
          <ThumbnailImg src={src} alt={filename} load={load} />
        </>
      )}
    </span>
  )
}

function AttachmentTooltip({ attrs, children }: { attrs: AttachmentReferenceAttrs; children: ReactNode }) {
  if (attrs.status === "uploading") return children

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        {attrs.status === "error" ? (
          <TooltipContent side="top" className="max-w-[200px]">
            <p className="text-sm">{attrs.error || "Upload failed"}</p>
          </TooltipContent>
        ) : (
          <TooltipContent side="top" className="max-w-[250px]">
            <div className="space-y-1">
              <p className="text-sm font-medium truncate">{attrs.filename}</p>
              <p className="text-xs text-muted-foreground">{formatFileSize(attrs.sizeBytes)}</p>
            </div>
          </TooltipContent>
        )}
      </Tooltip>
    </TooltipProvider>
  )
}

function ImageDisplayToggle({
  attrs,
  display,
  updateAttributes,
  focusAfterNode,
  children,
}: {
  attrs: AttachmentReferenceAttrs
  display: AttachmentDisplay
  updateAttributes: NodeViewProps["updateAttributes"]
  focusAfterNode: () => void
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const dismissedOutside = useRef(false)
  // The tooltip wraps only the trigger: focus moving into the portaled content
  // bubbles through the React tree, and an ancestor tooltip would open on it.
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <AttachmentTooltip attrs={attrs}>
        <PopoverTrigger asChild>
          <button type="button" aria-label={attrs.filename} className="inline cursor-pointer align-baseline">
            {children}
          </button>
        </PopoverTrigger>
      </AttachmentTooltip>
      <PopoverContent
        side="top"
        className="w-auto p-1"
        // The composer takes typing, a focused trigger does not; an outside
        // press already put focus where the user meant it.
        onInteractOutside={() => {
          dismissedOutside.current = true
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          if (!dismissedOutside.current) focusAfterNode()
          dismissedOutside.current = false
        }}
      >
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            updateAttributes({ display: toggledDisplay(display) })
            setOpen(false)
          }}
        >
          {DISPLAY_TOGGLE_LABEL[display]}
        </Button>
      </PopoverContent>
    </Popover>
  )
}

export function AttachmentReferenceView({ node, updateAttributes, editor, getPos }: NodeViewProps) {
  const attrs = node.attrs as AttachmentReferenceAttrs
  const { workspaceId } = useParams<{ workspaceId: string }>()
  const display = imageReferenceDisplay(node)
  const showInline = display === "inline" && attrs.status === "uploaded"

  const visual =
    showInline && workspaceId ? (
      <InlineImage workspaceId={workspaceId} attachmentId={attrs.id} filename={attrs.filename} />
    ) : (
      <AttachmentChip label={getDisplayText(attrs)} mimeType={attrs.mimeType} status={attrs.status} />
    )

  if (!display) {
    return (
      <AttachmentTooltip attrs={attrs}>
        <NodeViewWrapper as="span" data-type="attachment-reference">
          {visual}
        </NodeViewWrapper>
      </AttachmentTooltip>
    )
  }

  const focusAfterNode = () => {
    const pos = getPos()
    if (pos === undefined) editor.commands.focus()
    else editor.commands.focus(pos + node.nodeSize)
  }

  return (
    <NodeViewWrapper as="span" data-type="attachment-reference">
      <ImageDisplayToggle
        attrs={attrs}
        display={display}
        updateAttributes={updateAttributes}
        focusAfterNode={focusAfterNode}
      >
        {visual}
      </ImageDisplayToggle>
    </NodeViewWrapper>
  )
}
