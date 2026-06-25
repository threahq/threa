import { useMemo } from "react"
import { MediaGallery } from "@/components/image-gallery"
import { useStreamEvents } from "@/stores/stream-store"
import { deriveStreamContext } from "@/lib/stream-context/derive"
import { useStreamContextGalleryItems } from "./use-stream-gallery-items"

interface StreamContextGalleryProps {
  workspaceId: string
  streamId: string
  /** Current `?smedia=` key, or null when closed. */
  selectedKey: string | null
  /** Step to another item (gallery prev/next) — writes `?smedia=`. */
  onSelect: (key: string) => void
  onClose: () => void
}

/**
 * The "In this stream" media gallery: a single `MediaGallery` whose item set is
 * every gallery-renderable item in the stream (not one message's attachments),
 * opened from the context panel via `?smedia=`. Desktop shows it over the
 * timeline; mobile shows it full-screen — both inherited from `MediaGallery`.
 */
export function StreamContextGallery({
  workspaceId,
  streamId,
  selectedKey,
  onSelect,
  onClose,
}: StreamContextGalleryProps) {
  const events = useStreamEvents(streamId)
  // Derive only while the gallery is open — this mount lives for the whole
  // stream view. Gate on the boolean, not `selectedKey`: the key changes on
  // every prev/next step, which would re-run the O(events) scan each time.
  const isGalleryOpen = selectedKey != null
  const contextItems = useMemo(
    () => (isGalleryOpen ? deriveStreamContext(events).items : []),
    [events, isGalleryOpen]
  )
  const { items, initialIndex } = useStreamContextGalleryItems(workspaceId, contextItems, selectedKey)

  // A stale/not-yet-loaded `?smedia=` key resolves to nothing — keep the gallery
  // closed rather than opening on the wrong item.
  const isOpen = selectedKey != null && items.some((i) => i.attachmentId === selectedKey)

  return (
    <MediaGallery
      isOpen={isOpen}
      items={items}
      initialIndex={initialIndex}
      workspaceId={workspaceId}
      onClose={onClose}
      onItemChange={onSelect}
    />
  )
}
