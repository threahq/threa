import { api } from "./client"
import type { Stream, E2eActorKind } from "@threa/types"

export const e2eActorsApi = {
  /**
   * Invite a non-human actor (e.g. the enclave agent Ariadne) into an E2E
   * scratchpad. Owner-only on the backend; adds the actor to the stream's
   * `e2eActors` set and returns the updated stream.
   */
  async invite(workspaceId: string, streamId: string, kind: E2eActorKind): Promise<Stream> {
    const res = await api.post<{ stream: Stream }>(`/api/workspaces/${workspaceId}/streams/${streamId}/e2e/actors`, {
      kind,
    })
    return res.stream
  },
}
