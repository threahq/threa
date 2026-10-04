import { useCallback, useRef } from "react"
import { onboardingApi } from "@/api"
import { getActiveDb } from "@/db"

/** Creates (or reuses) the viewer's Meet Ariadne scratchpad and caches its id; resolves to the stream id. */
export function useMeetAriadne(workspaceId: string): () => Promise<string> {
  const inFlight = useRef<{ workspaceId: string; request: Promise<string> } | null>(null)
  return useCallback(() => {
    if (inFlight.current?.workspaceId === workspaceId) return inFlight.current.request
    // Resolved before the request so a workspace switch mid-flight cannot redirect the write.
    const database = getActiveDb()
    const request = (async () => {
      const { streamId } = await onboardingApi.meetAriadne(workspaceId)
      // Bootstrap and stream:created also record it, so a failed cache write must not block opening the stream.
      await database.workspaceMetadata
        .update(workspaceId, { onboardingStreamId: streamId })
        .catch((error) => console.warn("Failed to cache the Meet Ariadne stream", error))
      return streamId
    })().finally(() => {
      if (inFlight.current?.request === request) inFlight.current = null
    })
    inFlight.current = { workspaceId, request }
    return request
  }, [workspaceId])
}
