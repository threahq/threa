import { api } from "./client"
import type { Stream } from "@threa/types"

export const enclaveApi = {
  /**
   * Invite the first-party enclave agent (Ariadne) into an E2E scratchpad.
   * Owner-only on the backend; flips the stream's `e2eInvitedAgentKind` to
   * "enclave" and returns the updated stream.
   */
  async invite(workspaceId: string, streamId: string): Promise<Stream> {
    const res = await api.post<{ stream: Stream }>(`/api/workspaces/${workspaceId}/streams/${streamId}/invite-enclave`)
    return res.stream
  },
}
