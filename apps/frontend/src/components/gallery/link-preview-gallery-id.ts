// A link-preview image is an external URL, not an uploaded attachment — it has
// no attachment id, just the source url. The gallery keys item identity on
// `attachmentId`, so a preview image carries this sentinel id instead (mirrors
// the Giphy sentinel). Attachment-only actions (download and cross-origin copy)
// branch on it and are suppressed; render works straight from the url.
const LINK_PREVIEW_GALLERY_PREFIX = "link-preview:"

export function linkPreviewGalleryId(url: string): string {
  return `${LINK_PREVIEW_GALLERY_PREFIX}${url}`
}

export function isLinkPreviewGalleryId(id: string): boolean {
  return id.startsWith(LINK_PREVIEW_GALLERY_PREFIX)
}
