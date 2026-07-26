import { useMemo } from "react"
import { StreamTypes } from "@threa/types"
import { useWorkspaceStreamsRaw } from "@/stores/workspace-store"

/**
 * The id of the thread already anchored on `anchorId` in `parentStreamId`, or
 * null when there is none. Covers both anchor tracks (`msg_…` and `event_…`) —
 * unlike the board's structural index, which excludes card anchors on purpose.
 *
 * Cache-only: a null means "no thread known on this client", never "no thread
 * exists". Callers open the draft anchor in that case and let the draft panel's
 * promotion resolve it, which is the pre-existing path.
 */
export function useAnchoredThreadId(
  workspaceId: string | undefined,
  parentStreamId: string | null | undefined,
  anchorId: string | null | undefined
): string | null {
  const streams = useWorkspaceStreamsRaw(workspaceId)
  return useMemo(() => {
    if (!parentStreamId || !anchorId) return null
    const thread = streams.find(
      (stream) =>
        stream.type === StreamTypes.THREAD &&
        stream.parentStreamId === parentStreamId &&
        (stream.parentAnchorId ?? stream.parentMessageId) === anchorId
    )
    return thread?.id ?? null
  }, [streams, parentStreamId, anchorId])
}
