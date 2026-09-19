import { api } from "./client"
import type { E2eActorKind, E2eActorMutationResponse } from "@threahq/types"

export const e2eActorsApi = {
  /**
   * Invite a non-human actor (a bot or the enclave agent Ariadne) into an E2E
   * scratchpad. Owner-only on the backend; adds the actor to the stream's
   * `e2eActors` set and returns the updated stream plus the key roll the owner
   * must perform — minting a fresh SSK and wrapping it to the new recipient set
   * — or `keyRoll: null` when there is no live actor key to wrap to yet.
   */
  async invite(
    workspaceId: string,
    streamId: string,
    kind: E2eActorKind,
    actorId?: string
  ): Promise<E2eActorMutationResponse> {
    return api.post<E2eActorMutationResponse>(`/api/workspaces/${workspaceId}/streams/${streamId}/e2e/actors`, {
      kind,
      actorId,
    })
  },

  /**
   * Take an actor back off an E2E scratchpad. Owner-only; removes it from the
   * root and every thread under it, drops the wraps only that actor could open,
   * and returns the roll that re-keys the stream to whoever is left.
   */
  async revoke(
    workspaceId: string,
    streamId: string,
    kind: E2eActorKind,
    actorId: string
  ): Promise<E2eActorMutationResponse> {
    return api.delete<E2eActorMutationResponse>(
      `/api/workspaces/${workspaceId}/streams/${streamId}/e2e/actors/${kind}/${encodeURIComponent(actorId)}`
    )
  },
}
