import type { LinkPreviewSummary } from "@threahq/types"
import type { GalleryItem } from "@/components/image-gallery"

// External slides use this sentinel to gate attachment-only actions.
const LINK_PREVIEW_GALLERY_PREFIX = "link-preview:"

export function linkPreviewGalleryId(identity: string): string {
  return `${LINK_PREVIEW_GALLERY_PREFIX}${identity}`
}

export function isLinkPreviewGalleryId(id: string): boolean {
  return id.startsWith(LINK_PREVIEW_GALLERY_PREFIX)
}

export function linkPreviewImageItem(messageId: string, preview: LinkPreviewSummary): GalleryItem {
  const src = preview.imageUrl ?? preview.url
  return {
    type: "image",
    url: src,
    thumbnailUrl: src,
    filename: preview.title ?? linkPreviewDomain(preview.url),
    attachmentId: linkPreviewGalleryId(`${messageId}:${preview.id}`),
  }
}

export function linkPreviewDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "")
  } catch {
    return url
  }
}
