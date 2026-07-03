import { api } from "./client"

/**
 * Agent follow-ups (roadmap 1.3). Only cancel is first-party — the timeline
 * card's Cancel button. Scheduling/listing are the persona's tools, not a
 * client surface.
 */
export const agentFollowUpsApi = {
  /**
   * Cancel a pending follow-up. `cancelled` is `false` when the cancel lost the
   * race to the fire worker (already fired/cancelled); the call still resolves
   * so a double-click is harmless.
   */
  async cancel(workspaceId: string, id: string): Promise<{ cancelled: boolean }> {
    return api.post<{ cancelled: boolean }>(`/api/workspaces/${workspaceId}/agent-follow-ups/${id}/cancel`, {})
  },
}
