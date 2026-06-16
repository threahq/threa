import { useEffect, useRef } from "react"
import { useQueryClient } from "@tanstack/react-query"
import type { EnclaveRewrapNeededPayload } from "@threa/types"
import { useSocket } from "@/contexts"
import { useWorkspaceUserId } from "@/hooks/use-workspaces"
import { useE2eSession } from "@/stores/e2e-session-store"
import { reviveStaleActorWraps } from "@/lib/crypto/stream-key-cache"
import { e2eKeyWrapKeys } from "./stream-encryption-affordance"

/**
 * Workspace-level heal for the proactive re-wrap nudge. The backend fires
 * `enclave:rewrap_needed` at an E2E scratchpad owner when a turn there is stuck
 * because no live agent instance holds the stream's key — only the owner's
 * unlocked device can re-wrap it (the enclave can't seal to itself, INV-E7).
 * The per-stream affordance only heals the stream the owner has open; this lifts
 * that to the workspace so a turn in a scratchpad the owner *isn't* looking at
 * still resolves the moment the signal lands, without waiting for them to open
 * it. A locked session can't re-wrap: this listener drops the event, and the
 * per-stream affordance only heals once the owner actually opens that stream —
 * so an owner who unlocks without visiting it relies on the backend re-emitting
 * the nudge (every `REWRAP_SOCKET_REEMIT_MS`) to a now-unlocked tab. The graced
 * web-push is the offline owner's path back.
 *
 * Side-effect only; renders nothing. Mounted once per workspace inside the
 * socket + E2E-session providers.
 */
export function EnclaveRewrapNudgeListener({ workspaceId }: { workspaceId: string }): null {
  const socket = useSocket()
  const userId = useWorkspaceUserId(workspaceId)
  const session = useE2eSession(workspaceId, userId ?? "")
  const queryClient = useQueryClient()

  // The signal is rare and the session changes often; keep the handler stable
  // and read the current session through a ref so an unlock/lock doesn't churn
  // the socket subscription.
  const stateRef = useRef({ userId, session, queryClient })
  stateRef.current = { userId, session, queryClient }

  useEffect(() => {
    if (!socket) return

    const handle = (payload: EnclaveRewrapNeededPayload) => {
      const { userId, session, queryClient } = stateRef.current
      if (payload.workspaceId !== workspaceId || payload.targetUserId !== userId || !userId) return
      // Only an unlocked owner can re-wrap; a locked session heals on its next
      // unlock via the per-stream affordance.
      if (session.status !== "unlocked" || !session.keyId || !session.privateKey) return

      void reviveStaleActorWraps({
        workspaceId,
        streamId: payload.rootStreamId,
        userId,
        ownerKeyId: session.keyId,
        ownerPrivateKey: session.privateKey,
      })
        .then((result) => {
          if (result === "revived") {
            queryClient.invalidateQueries({ queryKey: e2eKeyWrapKeys.list(workspaceId, payload.rootStreamId) })
          }
        })
        .catch((err) => {
          console.error("Failed to revive stale actor wraps from nudge", err)
        })
    }

    socket.on("enclave:rewrap_needed", handle)
    return () => {
      socket.off("enclave:rewrap_needed", handle)
    }
  }, [socket, workspaceId])

  return null
}
