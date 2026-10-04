import { StreamTypes, type StreamContextScope } from "@threahq/types"
import { useStreamFromStore } from "@/stores/stream-store"

/**
 * Which index rows a stream's panel lists. A root lists its whole thread tree
 * (INV-62 — a thread's content belongs to its root's context); a thread lists
 * only its own rows, where a nested thread shows as its landmark.
 */
export function useStreamContextScope(
  workspaceId: string,
  streamId: string
): { rootStreamId: string; scope: StreamContextScope } {
  const stream = useStreamFromStore(workspaceId, streamId)
  return {
    rootStreamId: stream?.rootStreamId ?? streamId,
    scope: stream?.type === StreamTypes.THREAD ? "stream" : "tree",
  }
}
