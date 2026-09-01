import { api } from "./client"

/**
 * Subagent runs. The timeline card renders entirely from its own payload plus
 * the in-window status patches, so there is no read endpoint here — only the
 * two first-party transitions the card's actions drive.
 */
export const subagentsApi = {
  /**
   * Cancel an active run. `cancelled` is false when the run already settled
   * (reported back, failed, expired) — a lost race, not an error.
   */
  async cancel(workspaceId: string, id: string): Promise<{ cancelled: boolean }> {
    return api.post<{ cancelled: boolean }>(`/api/workspaces/${workspaceId}/subagents/${id}/cancel`, {})
  },

  /**
   * Re-activate a failed or expired run and re-enqueue its kickoff turn.
   * `requeued` is false when another transition won first; a 409 means a
   * different subagent claimed the stream's one live slot in the meantime.
   */
  async requeue(workspaceId: string, id: string): Promise<{ requeued: boolean }> {
    return api.post<{ requeued: boolean }>(`/api/workspaces/${workspaceId}/subagents/${id}/requeue`, {})
  },
}
