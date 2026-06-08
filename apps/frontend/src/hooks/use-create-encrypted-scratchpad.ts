import { useCallback } from "react"
import { useQueryClient } from "@tanstack/react-query"
import {
  StreamTypes,
  type Stream,
  type StreamMember,
  type WorkspaceBootstrap,
  type StreamWithPreview,
} from "@threa/types"
import { toast } from "sonner"
import { db } from "@/db"
import { useStreamService } from "@/contexts"
import { workspaceKeys } from "@/hooks/use-workspaces"
import { getE2eSessionState } from "@/stores/e2e-session-store"
import { provisionOwnerStreamKey } from "@/lib/crypto/stream-key-cache"
import { useSyncEngine } from "@/sync/sync-engine"
import { inviteActorToStream } from "@/hooks/use-invite-actor"

export function useCreateEncryptedScratchpad(workspaceId: string, currentUserId: string | null) {
  const streamService = useStreamService()
  const queryClient = useQueryClient()
  const syncEngine = useSyncEngine()

  // E2E scratchpads default to having Ariadne (the enclave actor) invited so
  // they get AI replies out of the box; the no-AI "encrypted quick note" path
  // passes `withAriadne: false`.
  return useCallback(
    async (withAriadne: boolean = true): Promise<string> => {
      if (!currentUserId) {
        throw new Error("Workspace user not resolved yet — try again in a moment")
      }
      const session = getE2eSessionState(workspaceId, currentUserId)
      if (session.status !== "unlocked" || !session.keyId || !session.publicKey) {
        // Callers onboard first (the sidebar opens setup/unlock inline before
        // calling this), so reaching here is a programming error, not a
        // user-facing state — never surface a "go set up encryption" message.
        throw new Error("createEncryptedScratchpad called without an unlocked E2E session")
      }
      const ownerKeyId = session.keyId
      const ownerPublicKey = session.publicKey
      const stream = await streamService.create(workspaceId, {
        type: StreamTypes.SCRATCHPAD,
        e2eEnabled: true,
        e2eOwnerKeyId: ownerKeyId,
      })

      // Two-phase E2E setup: the stream id is minted server-side, and the SSK
      // wrap's AAD binds to that id — so we provision the generation-0 SSK only
      // once the id is known. INV-E1: no plaintext can be written before this
      // lands — the send path refuses to seal until it can resolve the SSK. If
      // this throws (e.g. the wrap store fails) the stream is left with zero
      // wraps; rather than tear it down, the locked-state repair affordance
      // re-runs the same provisioning path to finish setup.
      await provisionOwnerStreamKey({ workspaceId, streamId: stream.id, ownerKeyId, ownerPublicKey })

      // Mirror useCreateStream: subscribe immediately so creator gets stream-level
      // realtime before the workspace socket echo or next bootstrap catches up.
      void syncEngine.subscribeStream(stream.id)

      const membership: StreamMember = {
        streamId: stream.id,
        memberId: stream.createdBy,
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
          notificationLevel: null,
          lastReadEventId: null,
          lastReadAt: null,
          joinedAt: stream.createdAt,
          _cachedAt: now,
        }),
      ])

      // Primary path: invite Ariadne (the enclave actor) so encrypted scratchpads
      // get AI replies by default. Best-effort — the scratchpad already exists and
      // is usable; surface a non-fatal toast if the invite/wrap fails so the user
      // can re-invite via the in-stream affordance.
      if (withAriadne) {
        try {
          await inviteActorToStream({
            workspaceId,
            streamId: stream.id,
            kind: "enclave",
            queryClient,
            owner: { keyId: ownerKeyId, publicKey: ownerPublicKey },
          })
        } catch (err) {
          const message = err instanceof Error ? err.message : "Couldn't enable Ariadne for this scratchpad"
          toast.error(message)
        }
      }

      return stream.id
    },
    [workspaceId, currentUserId, streamService, queryClient, syncEngine]
  )
}
