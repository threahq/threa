import { useEffect, useRef, useState, type ReactNode } from "react"
import { useParams } from "react-router-dom"
import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react"
import { Play } from "lucide-react"
import { attachmentReferenceLabel } from "@threahq/prosemirror"
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Button } from "@/components/ui/button"
import { AttachmentChip } from "@/components/timeline/attachment-chip"
import { ThumbnailImg, thumbnailBox, useThumbnailLoadState } from "@/components/timeline/attachment-thumbnail"
import { attachmentContentUrl } from "@/api"
import { uploadGalleryType } from "@/components/gallery/upload-preview"
import { isVideoAttachment } from "@/lib/attachment-kind"
import { getUploadJobByAttachmentId } from "@/lib/uploads/upload-manager"
import { cn } from "@/lib/utils"
import { useMediaViewer } from "./media-viewer-context"
import { mediaRowColumns } from "./media-rows-extension"
import {
  displayToggleLabel,
  mediaReferenceDisplay,
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

// A peer's image can 403 while its bytes are still uploading or being scanned, and no event says when that ends.
const LOAD_RETRY_DELAYS_MS = [2_000, 4_000, 8_000, 15_000, 30_000, 30_000, 30_000, 30_000, 30_000]

/** Retries a failed thumbnail load on a backoff; true once the retries are spent. */
function useLoadRetries({ error, retryLoad }: ReturnType<typeof useThumbnailLoadState>): boolean {
  const [retries, setRetries] = useState(0)
  const retryDelayMs = LOAD_RETRY_DELAYS_MS[retries]
  useEffect(() => {
    if (!error || retryDelayMs === undefined) return
    const timer = setTimeout(() => {
      setRetries((count) => count + 1)
      retryLoad()
    }, retryDelayMs)
    return () => clearTimeout(timer)
  }, [error, retryDelayMs, retryLoad])
  return error && retryDelayMs === undefined
}

// The id is reserved before the bytes land, so the server thumbnail can 404
// mid-upload; the job's local preview lives until the composer releases it.
function imageThumbnailSrc(workspaceId: string, attachmentId: string): string {
  return (
    getUploadJobByAttachmentId(attachmentId)?.previewUrl ??
    attachmentContentUrl(workspaceId, attachmentId, { variant: "thumbnail" })
  )
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
  const gaveUp = useLoadRetries(load)
  const box = thumbnailBox()

  return (
    <span
      style={{ width: box.width, height: box.height }}
      className="relative inline-block align-top overflow-hidden rounded-lg border bg-muted/30"
    >
      {gaveUp ? (
        <span className="absolute inset-0 flex items-center justify-center p-2 text-center text-xs text-muted-foreground">
          Image unavailable
        </span>
      ) : (
        <>
          {!load.decoded && <span className="absolute inset-0 animate-pulse bg-muted" />}
          <ThumbnailImg src={imageThumbnailSrc(workspaceId, attachmentId)} alt={filename} load={load} />
        </>
      )}
    </span>
  )
}

/**
 * An image or video drawn as a doc's media: a lone one keeps its own shape across the full width, one sharing a row
 * is cropped to a tile. A video shows its thumbnail under a play badge, and the badge alone once no thumbnail loads.
 */
function RowMedia({
  workspaceId,
  attrs,
  columns,
}: {
  workspaceId: string
  attrs: AttachmentReferenceAttrs
  columns: number
}) {
  const load = useThumbnailLoadState()
  const gaveUp = useLoadRetries(load)
  const video = isVideoAttachment(attrs)
  const tile = columns > 1
  const src = video
    ? attachmentContentUrl(workspaceId, attrs.id, { variant: "thumbnail" })
    : imageThumbnailSrc(workspaceId, attrs.id)

  return (
    <span
      className={cn(
        "relative block w-full overflow-hidden rounded-lg border bg-muted/30",
        tile ? "aspect-[4/3]" : !load.decoded && "aspect-video"
      )}
    >
      {attrs.status === "uploaded" && !gaveUp && (
        <ThumbnailImg
          src={src}
          alt={attrs.filename}
          load={load}
          className={tile ? undefined : "relative block h-auto max-h-[28rem] object-contain"}
        />
      )}
      {!load.decoded && !gaveUp && <span className="absolute inset-0 animate-pulse bg-muted" />}
      {gaveUp && !video && (
        <span className="absolute inset-0 flex items-center justify-center p-2 text-center text-xs text-muted-foreground">
          Image unavailable
        </span>
      )}
      {video && (
        <span className="absolute inset-0 flex items-center justify-center">
          <span className="rounded-full bg-black/60 p-3 text-white">
            <Play className="size-5 fill-current" />
          </span>
        </span>
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

/** An editable surface's actions for a reference: open it in the gallery, and switch it between chip and media. */
function AttachmentActions({
  attrs,
  display,
  fill,
  updateAttributes,
  focusAfterNode,
  onOpen,
  children,
}: {
  attrs: AttachmentReferenceAttrs
  display: AttachmentDisplay | null
  fill: boolean
  updateAttributes: NodeViewProps["updateAttributes"]
  focusAfterNode: () => void
  onOpen: (() => void) | null
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
          <button type="button" aria-label={attrs.filename} className={cn("cursor-pointer", triggerClass(fill))}>
            {children}
          </button>
        </PopoverTrigger>
      </AttachmentTooltip>
      <PopoverContent
        side="top"
        className="flex w-auto gap-1 p-1"
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
        {onOpen && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              // The gallery takes focus; handing it back to the editor would race it.
              dismissedOutside.current = true
              setOpen(false)
              onOpen()
            }}
          >
            Open
          </Button>
        )}
        {display && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              updateAttributes({ display: toggledDisplay(display) })
              setOpen(false)
            }}
          >
            {displayToggleLabel(display, isVideoAttachment(attrs))}
          </Button>
        )}
      </PopoverContent>
    </Popover>
  )
}

function triggerClass(fill: boolean): string {
  return fill ? "block w-full text-left" : "inline align-baseline"
}

export function AttachmentReferenceView({ node, updateAttributes, editor, getPos, decorations }: NodeViewProps) {
  const attrs = node.attrs as AttachmentReferenceAttrs
  const { workspaceId } = useParams<{ workspaceId: string }>()
  const viewer = useMediaViewer()
  const display = mediaReferenceDisplay(node, { videos: !!viewer })
  const openMedia =
    viewer && attrs.status === "uploaded" && uploadGalleryType(attrs) ? () => viewer.open(attrs.id) : null
  const columns = viewer && display === "inline" ? mediaRowColumns(decorations) : null
  const rowClass = columns ? "w-full py-1" : undefined

  let visual: ReactNode
  if (columns && workspaceId) visual = <RowMedia workspaceId={workspaceId} attrs={attrs} columns={columns} />
  else if (display === "inline" && attrs.status === "uploaded" && workspaceId)
    visual = <InlineImage workspaceId={workspaceId} attachmentId={attrs.id} filename={attrs.filename} />
  else visual = <AttachmentChip label={getDisplayText(attrs)} mimeType={attrs.mimeType} status={attrs.status} />

  if (!display && !openMedia) {
    return (
      <AttachmentTooltip attrs={attrs}>
        <NodeViewWrapper as="span" data-type="attachment-reference">
          {visual}
        </NodeViewWrapper>
      </AttachmentTooltip>
    )
  }

  if (viewer?.readOnly) {
    return (
      <NodeViewWrapper as="span" data-type="attachment-reference" className={rowClass}>
        {openMedia ? (
          <button
            type="button"
            aria-label={attrs.filename}
            className={cn("cursor-zoom-in", triggerClass(!!columns))}
            onClick={openMedia}
          >
            {visual}
          </button>
        ) : (
          visual
        )}
      </NodeViewWrapper>
    )
  }

  const focusAfterNode = () => {
    const pos = getPos()
    if (pos === undefined) editor.commands.focus()
    else editor.commands.focus(pos + node.nodeSize)
  }

  return (
    <NodeViewWrapper as="span" data-type="attachment-reference" className={rowClass}>
      <AttachmentActions
        attrs={attrs}
        display={display}
        fill={!!columns}
        updateAttributes={updateAttributes}
        focusAfterNode={focusAfterNode}
        onOpen={openMedia}
      >
        {visual}
      </AttachmentActions>
    </NodeViewWrapper>
  )
}
