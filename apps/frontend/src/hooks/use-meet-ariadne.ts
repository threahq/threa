import { useCallback } from "react"
import { onboardingApi } from "@/api"
import { db } from "@/db"

/** Creates (or reuses) the viewer's Meet Ariadne scratchpad and caches its id; resolves to the stream id. */
export function useMeetAriadne(workspaceId: string): () => Promise<string> {
  return useCallback(async () => {
    const { streamId } = await onboardingApi.meetAriadne(workspaceId)
    // Bootstrap and stream:created also record it, so a failed cache write must not block opening the stream.
    await db.workspaceMetadata
      .update(workspaceId, { onboardingStreamId: streamId })
      .catch((error) => console.warn("Failed to cache the Meet Ariadne stream", error))
    return streamId
  }, [workspaceId])
}
