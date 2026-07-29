import { useMemo } from "react"
import { MediaGallery } from "@/components/image-gallery"
import { useStreamEvents, useStreamFromStore } from "@/stores/stream-store"
import { useStreamContextRows } from "@/stores/stream-context-store"
import { deriveStreamContext } from "@/lib/stream-context/derive"
import { collapseContextRows } from "@/lib/stream-context/filter"
import { contextItemFromCached } from "@/lib/stream-context/from-cached"
import type { ContextItem } from "@/lib/stream-context/types"
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
  const stream = useStreamFromStore(streamId)
  const rootStreamId = stream?.rootStreamId ?? streamId
  // The panel's rows come from the server index under `scope: "tree"`, so they
  // routinely point at attachments outside the loaded event window (older, or in
  // a thread). Deriving here would leave those rows opening nothing, so the
  // gallery reads the same set the panel rendered. Sealed streams have no index
  // rows and stay on the derive path, as the panel does.
  const indexed = !stream?.e2eEnabled
  const rows = useStreamContextRows(workspaceId, streamId, rootStreamId, "tree")
  // Derive only while the gallery is open — this mount lives for the whole
  // stream view. Gate on the boolean, not `selectedKey`: the key changes on
  // every prev/next step, which would re-run the O(events) scan each time.
  const isGalleryOpen = selectedKey != null
  const contextItems = useMemo(() => {
    if (!isGalleryOpen) return []
    if (indexed)
      return collapseContextRows(rows ?? [])
        .map(contextItemFromCached)
        .filter((item): item is ContextItem => item !== null)
    return deriveStreamContext(events).items
  }, [events, isGalleryOpen, indexed, rows])
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
