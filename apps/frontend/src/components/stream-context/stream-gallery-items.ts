import { attachmentContentUrl } from "@/api"
import type { GalleryItem } from "@/components/image-gallery"
import { giphyGalleryId } from "@/components/gallery/giphy-gallery-id"
import type { GalleryUrlKind } from "@/components/gallery/use-gallery-attachment-urls"
import {
  isHtmlAttachment,
  isMarkdownAttachment,
  isPdfAttachment,
  isTextPreviewableAttachment,
} from "@/lib/attachment-kind"
import type { ContextItem } from "@/lib/stream-context/types"

/**
 * Map the "In this stream" panel's items into `MediaGallery` items, preserving
 * the panel's order so the gallery's prev/next browses the whole stream.
 *
 * Only gallery-renderable items are included — images, inline/uploaded GIFs,
 * videos, and previewable documents (pdf/markdown/html/text, decided by the
 * canonical `is*Attachment` helpers, the single source of truth for "opens in
 * the gallery"). Links, memos, threads, and non-previewable files are dropped;
 * their rows keep their existing actions.
 *
 * Video and document items carry an empty `url` here — only the *selected*
 * item's presigned URL is fetched (see `useGalleryAttachmentUrls`); images and
 * GIFs render from deterministic/CDN urls set inline.
 */
export function buildStreamGalleryItems(workspaceId: string, items: readonly ContextItem[]): GalleryItem[] {
  const out: GalleryItem[] = []

  for (const item of items) {
    if (item.category === "media") {
      if (item.mediaKind === "video") {
        if (!item.attachmentId) continue
        out.push({
          type: "video",
          url: "",
          thumbnailUrl: attachmentContentUrl(workspaceId, item.attachmentId, { variant: "thumbnail" }),
          filename: item.filename,
          attachmentId: item.attachmentId,
        })
      } else if (item.giphyUrl) {
        out.push({
          type: "image",
          url: item.giphyUrl,
          thumbnailUrl: item.giphyUrl,
          filename: item.filename,
          attachmentId: giphyGalleryId(item.giphyUrl),
        })
      } else if (item.attachmentId) {
        out.push({
          type: "image",
          url: attachmentContentUrl(workspaceId, item.attachmentId),
          thumbnailUrl: attachmentContentUrl(workspaceId, item.attachmentId, { variant: "thumbnail" }),
          filename: item.filename,
          attachmentId: item.attachmentId,
        })
      }
      continue
    }

    if (item.category === "file") {
      const shape = { mimeType: item.mimeType, filename: item.filename }
      const type = galleryDocType(shape)
      if (!type) continue
      out.push({ type, url: "", filename: item.filename, attachmentId: item.attachmentId })
    }
  }

  return out
}

export function galleryDocType(shape: {
  mimeType: string
  filename: string
}): "pdf" | "markdown" | "html" | "text" | null {
  if (isPdfAttachment(shape)) return "pdf"
  if (isMarkdownAttachment(shape)) return "markdown"
  if (isHtmlAttachment(shape)) return "html"
  if (isTextPreviewableAttachment(shape)) return "text"
  return null
}

/** Which presigned URL the gallery item needs when selected (see the URL hook). */
export function galleryFetchKind(item: GalleryItem): GalleryUrlKind {
  if (item.type === "video") return "video"
  if (item.type === "pdf" || item.type === "markdown" || item.type === "html" || item.type === "text") {
    return "document"
  }
  return null
}
