import { api } from "./client"

/**
 * Delegated tasks (roadmap 5.2). Only cancel is first-party — the timeline
 * card's Cancel button. Creation is the persona's `delegate_task` tool and the
 * claim/complete lifecycle is the local agent's public API (5.3), not a client
 * surface.
 */
export const delegationsApi = {
  /**
   * Cancel a non-terminal delegation. `cancelled` is `false` when the cancel
   * lost the race (already completed/failed/expired/cancelled); the call still
   * resolves so a double-click is harmless.
   */
  async cancel(workspaceId: string, id: string): Promise<{ cancelled: boolean }> {
    return api.post<{ cancelled: boolean }>(`/api/workspaces/${workspaceId}/delegations/${id}/cancel`, {})
  },
}
