import { useMemo } from "react"
import type { GalleryItem } from "@/components/image-gallery"
import { isGiphyGalleryId } from "@/components/gallery/giphy-gallery-id"
import { useGalleryAttachmentUrls } from "@/components/gallery/use-gallery-attachment-urls"
import type { ContextItem } from "@/lib/stream-context/types"
import { buildStreamGalleryItems, galleryFetchKind } from "./stream-gallery-items"

/**
 * The `MediaGallery` item set for the stream-context gallery, plus the index of
 * the currently selected key. Resolves the selected video/document's presigned
 * URL lazily (images and GIFs need none); off-screen video/doc items keep an
 * empty url until the user lands on them.
 */
export function useStreamContextGalleryItems(
  workspaceId: string,
  contextItems: readonly ContextItem[],
  selectedKey: string | null
): { items: GalleryItem[]; initialIndex: number } {
  const baseItems = useMemo(() => buildStreamGalleryItems(workspaceId, contextItems), [workspaceId, contextItems])

  const selected = useMemo(
    () => baseItems.find((i) => i.attachmentId === selectedKey) ?? null,
    [baseItems, selectedKey]
  )
  const fetchId = selected && !isGiphyGalleryId(selected.attachmentId) ? selected.attachmentId : null
  const fetchKind = selected ? galleryFetchKind(selected) : null

  const urls = useGalleryAttachmentUrls(workspaceId, fetchId, fetchKind)

  const items = useMemo(
    () =>
      baseItems.map((i) =>
        galleryFetchKind(i) && urls.has(i.attachmentId) ? { ...i, url: urls.get(i.attachmentId) ?? "" } : i
      ),
    [baseItems, urls]
  )

  const initialIndex = useMemo(() => {
    const idx = items.findIndex((i) => i.attachmentId === selectedKey)
    return idx < 0 ? 0 : idx
  }, [items, selectedKey])

  return { items, initialIndex }
}
