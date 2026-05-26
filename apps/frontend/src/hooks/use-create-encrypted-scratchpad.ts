import { useCallback } from "react"
import { useQueryClient } from "@tanstack/react-query"
import {
  StreamTypes,
  type Stream,
  type StreamMember,
  type WorkspaceBootstrap,
  type StreamWithPreview,
} from "@threa/types"
import { db } from "@/db"
import { useStreamService } from "@/contexts"
import { workspaceKeys } from "@/hooks/use-workspaces"
import { getE2eSessionState } from "@/stores/e2e-session-store"
import { useSyncEngine } from "@/sync/sync-engine"

export function useCreateEncryptedScratchpad(workspaceId: string, currentUserId: string | null) {
  const streamService = useStreamService()
  const queryClient = useQueryClient()
  const syncEngine = useSyncEngine()

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

    // Mirror useCreateStream: subscribe immediately so creator gets stream-level
    // realtime before the workspace socket echo or next bootstrap catches up.
    void syncEngine.subscribeStream(stream.id)

    const membership: StreamMember = {
      streamId: stream.id,
      memberId: stream.createdBy,
      pinned: false,
      pinnedAt: null,
      notificationLevel: null,
      lastReadEventId: null,
      lastReadAt: null,
      joinedAt: stream.createdAt,
    }

    queryClient.setQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap(workspaceId), (old) => {
      if (!old) return old
      const exists = old.streams?.some((s: Stream) => s.id === stream.id)
      if (exists) return old
      const withPreview: StreamWithPreview = { ...stream, lastMessagePreview: null }
      return {
        ...old,
        streams: [...(old.streams ?? []), withPreview],
        streamMemberships: [...(old.streamMemberships ?? []), membership],
      }
    })

    const now = Date.now()
    await Promise.all([
      db.streams.put({ ...stream, lastMessagePreview: null, _cachedAt: now }),
      db.streamMemberships.put({
        id: `${workspaceId}:${stream.id}`,
        workspaceId,
        streamId: stream.id,
        memberId: stream.createdBy,
        pinned: false,
        pinnedAt: null,
        notificationLevel: null,
        lastReadEventId: null,
        lastReadAt: null,
        joinedAt: stream.createdAt,
        _cachedAt: now,
      }),
    ])

    return stream.id
  }, [workspaceId, currentUserId, streamService, queryClient, syncEngine])
}
