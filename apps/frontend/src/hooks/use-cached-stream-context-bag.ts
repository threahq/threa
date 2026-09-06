import { useMemo } from "react"
import type { StreamContextBagPayload } from "@threahq/types"
import { useWorkspaceStreams } from "@/stores/workspace-store"

const EMPTY: StreamContextBagPayload = { bag: null, refs: [] }

/**
 * Synchronous read of a stream's persisted ContextBag from the IDB-backed
 * workspace stream cache. Used by the timeline message badge so the chip
 * renders on first paint — same path attachments use (`payload.attachments`
 * on the message event, also IDB-backed) — no fetch, no layout shift.
 *
 * The `contextBag` field on `CachedStream` is populated by
 * `applyStreamBootstrap` from the bootstrap response. Streams whose
 * bootstrap hasn't run yet on this device get `EMPTY` and the badge
 * stays hidden until bootstrap completes; the bootstrap then writes the
 * field and the cache signal triggers a synchronous re-render.
 */
export function useCachedStreamContextBag(
  workspaceId: string | undefined,
  streamId: string | undefined
): StreamContextBagPayload {
  const streams = useWorkspaceStreams(workspaceId)
  return useMemo(() => {
    if (!streamId) return EMPTY
    const stream = streams.find((s) => s.id === streamId)
    return stream?.contextBag ?? EMPTY
  }, [streams, streamId])
}
