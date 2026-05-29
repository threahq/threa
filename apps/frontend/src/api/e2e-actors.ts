import { api } from "./client"
import type { E2eActorKind, InviteActorResponse } from "@threa/types"

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
  ): Promise<InviteActorResponse> {
    return api.post<InviteActorResponse>(`/api/workspaces/${workspaceId}/streams/${streamId}/e2e/actors`, {
      kind,
      actorId,
    })
  },
}
