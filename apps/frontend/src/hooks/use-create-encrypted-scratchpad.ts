import { useCallback } from "react"
import { useQueryClient } from "@tanstack/react-query"
import {
  StreamTypes,
  type Stream,
  type StreamMember,
  type WorkspaceBootstrap,
  type StreamWithPreview,
} from "@threa/types"
import { bytesToBase64, buildWrapAad, generateStreamKey, wrapStreamKey } from "@threa/crypto"
import { db } from "@/db"
import { useStreamService } from "@/contexts"
import { e2eKeyWrapsApi } from "@/api/e2e-key-wraps"
import { workspaceKeys } from "@/hooks/use-workspaces"
import { getE2eSessionState } from "@/stores/e2e-session-store"
import { putStreamKey } from "@/lib/crypto/stream-key-cache"
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
    if (session.status !== "unlocked" || !session.keyId || !session.publicKey) {
      throw new Error("Unlock encrypted scratchpads first (Settings → Encryption)")
    }
    const ownerKeyId = session.keyId
    const ownerPublicKey = session.publicKey
    const stream = await streamService.create(workspaceId, {
      type: StreamTypes.SCRATCHPAD,
      e2eEnabled: true,
      e2eOwnerKeyId: ownerKeyId,
    })

    // Two-phase E2E setup: the stream id is minted server-side, and the SSK
    // wrap's AAD binds to that id — so we generate the generation-0 SSK, wrap
    // it to the owner's UIK bound to the now-known stream id, and store it.
    // Seed the in-memory cache too so the first send doesn't re-fetch a key we
    // already hold. INV-E1: no plaintext can be written before this lands —
    // the send path refuses to seal until it can resolve the SSK.
    const ssk = generateStreamKey()
    const wrap = await wrapStreamKey({
      key: ssk,
      recipientPublicKey: ownerPublicKey,
      aad: buildWrapAad({ streamId: stream.id, keyGeneration: 0, recipientKeyId: ownerKeyId }),
    })
    await e2eKeyWrapsApi.store(workspaceId, stream.id, {
      wrapEnc: bytesToBase64(wrap.enc),
      wrapCt: bytesToBase64(wrap.ct),
    })
    putStreamKey(workspaceId, stream.id, 0, ssk)

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
