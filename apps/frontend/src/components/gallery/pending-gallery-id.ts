// A composer preview image is a locally-picked file that hasn't been sent yet.
// Its bytes live only in a local object URL (and for E2E streams the server
// holds nothing but ciphertext), so the attachment download API can't serve it.
// The gallery keys item identity on `attachmentId`, so a preview image carries
// this sentinel instead (mirrors the Giphy / link-preview sentinels). Download
// branches on it and is suppressed; render + copy work straight from the url.
const PENDING_GALLERY_PREFIX = "pending:"

export function pendingGalleryId(key: string): string {
  return `${PENDING_GALLERY_PREFIX}${key}`
}

export function isPendingGalleryId(id: string): boolean {
  return id.startsWith(PENDING_GALLERY_PREFIX)
}
