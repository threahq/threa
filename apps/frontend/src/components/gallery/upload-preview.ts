import type { GalleryItem } from "@/components/image-gallery"
import { pendingGalleryId } from "@/components/gallery/pending-gallery-id"
import { galleryDocType } from "@/components/stream-context/stream-gallery-items"
import { isImageAttachment, isVideoAttachment } from "@/lib/attachment-kind"

/**
 * The gallery item types an *uploaded file* can produce. Every `GalleryItem`
 * type except `video-embed`, which is a third-party link-preview iframe with no
 * attachment bytes — it can never originate from a file the user picks/pastes.
 *
 * Written as `Exclude<…>` (not a hand-listed union) so adding a new
 * `GalleryItem["type"]` automatically widens this and forces {@link
 * buildPendingGalleryItem}'s exhaustive switch to handle it — the composer's
 * previewable set can't silently drift behind the gallery's.
 */
export type UploadGalleryType = Exclude<GalleryItem["type"], "video-embed">

/**
 * Single source of truth for "does an uploaded file preview in the composer, and
 * as which gallery type." Reuses the canonical `is*Attachment` / `galleryDocType`
 * classifiers that the timeline attachment list already uses, so a file previews
 * in the composer exactly when it would render in the timeline/board gallery.
 *
 * Returns `null` for non-previewable files (a `.zip`, an unknown binary) — those
 * keep a plain, non-tappable chip.
 */
export function uploadGalleryType(a: { mimeType: string; filename: string }): UploadGalleryType | null {
  if (isImageAttachment(a)) return "image"
  if (isVideoAttachment(a)) return "video"
  return galleryDocType(a)
}

/**
 * Build the `MediaGallery` item for a pending (pre-send) attachment. The
 * exhaustive `switch` is the compile-time drift guard: a new `UploadGalleryType`
 * that isn't handled here fails to type-check.
 *
 * `url` is the preview source — a local `blob:` object URL (live compose), a
 * presigned server URL, or an E2E-decrypted object URL — and doubles as the
 * image thumbnail (images self-thumbnail; video falls back to a Play glyph;
 * documents render an icon). The `pending:` sentinel id gates the gallery's
 * download affordance off (no server-servable bytes for a local object URL).
 */
export function buildPendingGalleryItem(
  type: UploadGalleryType,
  url: string,
  filename: string,
  key: string
): GalleryItem {
  const attachmentId = pendingGalleryId(key)
  switch (type) {
    case "image":
      return { type, url, thumbnailUrl: url, filename, attachmentId }
    case "video":
      return { type, url, thumbnailUrl: "", filename, attachmentId }
    case "pdf":
    case "markdown":
    case "html":
    case "text":
      return { type, url, filename, attachmentId }
    default: {
      const _exhaustive: never = type
      throw new Error(`Unhandled pending gallery type: ${String(_exhaustive)}`)
    }
  }
}
