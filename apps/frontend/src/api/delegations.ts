import type { ListDelegationsResponse } from "@threa/types"
import { api } from "./client"

/**
 * Delegated tasks (roadmap 5.2). First-party surface is cancel (the timeline
 * card's Cancel button) and the stream-scoped list (the "In this stream"
 * panel). Creation is the persona's `delegate_task` tool and the
 * claim/complete lifecycle is the local agent's public API (5.3), not a client
 * surface.
 */
export const delegationsApi = {
  /**
   * A stream's delegations with live statuses, newest first. The authoritative
   * read for list surfaces — statuses live in `delegation:status_changed`
   * patches, so deriving from the loaded timeline window would go stale.
   */
  async list(workspaceId: string, streamId: string): Promise<ListDelegationsResponse> {
    const params = new URLSearchParams({ streamId })
    return api.get<ListDelegationsResponse>(`/api/workspaces/${workspaceId}/delegations?${params.toString()}`)
  },

  /**
   * Cancel a non-terminal delegation. `cancelled` is `false` when the cancel
   * lost the race (already completed/failed/expired/cancelled); the call still
   * resolves so a double-click is harmless.
   */
  async cancel(workspaceId: string, id: string): Promise<{ cancelled: boolean }> {
    return api.post<{ cancelled: boolean }>(`/api/workspaces/${workspaceId}/delegations/${id}/cancel`, {})
  },

  /**
   * Mark a non-terminal delegation done — the close-the-loop affordance for
   * work executed outside the API path (copy-paste into a local agent).
   * Race-honest like cancel: `completed` is `false` when it was already terminal.
   */
  async markDone(workspaceId: string, id: string): Promise<{ completed: boolean }> {
    return api.post<{ completed: boolean }>(`/api/workspaces/${workspaceId}/delegations/${id}/done`, {})
  },
}
