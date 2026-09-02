import type { SubagentSummary } from "@threa/types"
import { api } from "./client"

/**
 * Subagent runs. The timeline card renders from its own payload plus the
 * in-window status patches; the read below is the fallback for a surface whose
 * window cannot hold those patches, not the card's normal path.
 */
export const subagentsApi = {
  /**
   * The authoritative run. Access-checked and 404-hiding server-side (a run the
   * viewer cannot reach 404s exactly like a missing one).
   */
  async get(workspaceId: string, id: string): Promise<SubagentSummary> {
    const { subagent } = await api.get<{ subagent: SubagentSummary }>(`/api/workspaces/${workspaceId}/subagents/${id}`)
    return subagent
  },

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
