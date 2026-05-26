import { useCallback } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { StreamTypes, type Stream, type WorkspaceBootstrap, type StreamWithPreview } from "@threa/types"
import { db } from "@/db"
import { useStreamService } from "@/contexts"
import { workspaceKeys } from "@/hooks/use-workspaces"
import { getE2eSessionState } from "@/stores/e2e-session-store"

export function useCreateEncryptedScratchpad(workspaceId: string, currentUserId: string | null) {
  const streamService = useStreamService()
  const queryClient = useQueryClient()

  return useCallback(async (): Promise<string> => {
    if (!currentUserId) {
      throw new Error("Workspace user not resolved yet — try again in a moment")
    }
    const session = getE2eSessionState(workspaceId, currentUserId)
    if (session.status !== "unlocked" || !session.keyId) {
      throw new Error("Unlock encrypted scratchpads first (Settings → Encryption)")
    }
    const stream = await streamService.create(workspaceId, {
      type: StreamTypes.SCRATCHPAD,
      e2eEnabled: true,
      e2eOwnerKeyId: session.keyId,
    })
    await db.streams.put({
      ...stream,
      lastMessagePreview: null,
      _cachedAt: Date.now(),
    })
    queryClient.setQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap(workspaceId), (old) => {
      if (!old) return old
      const exists = old.streams?.some((s: Stream) => s.id === stream.id)
      if (exists) return old
      const withPreview: StreamWithPreview = { ...stream, lastMessagePreview: null }
      return { ...old, streams: [...(old.streams ?? []), withPreview] }
    })
    return stream.id
  }, [workspaceId, currentUserId, streamService, queryClient])
}
