// Inline Giphy GIFs aren't uploaded attachments — they have no attachment id,
// just a CDN url. The gallery keys item identity (and its `?smedia=`/`?media=`
// sync, thumbnail strip, and onItemChange) on `attachmentId`, so a Giphy item
// carries this sentinel id instead. Attachment-only actions (download via the
// attachments API) branch on it; render and copy work straight from the url.
const GIPHY_GALLERY_PREFIX = "giphy:"

export function giphyGalleryId(giphyUrl: string): string {
  return `${GIPHY_GALLERY_PREFIX}${giphyUrl}`
}

export function isGiphyGalleryId(id: string): boolean {
  return id.startsWith(GIPHY_GALLERY_PREFIX)
}
