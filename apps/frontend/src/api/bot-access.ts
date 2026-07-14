import { api } from "./client"

/**
 * Bot access requests (F3). First-party surface is the Approve / Deny buttons
 * on the request card that a bot runtime files when it lacks stream access.
 * Both are race-honest like the delegation cancel/markDone shape: the boolean
 * is `false` when the request already reached a terminal state, so a
 * double-click (or two members racing) is harmless and never errors.
 */
export const botAccessApi = {
  /**
   * Approve a request — applies the bot grant and re-nudges the runner in the
   * same transaction (server-side). `approved` is `false` when the approve lost
   * the race (already approved/denied); the call still resolves.
   */
  async approve(workspaceId: string, id: string): Promise<{ approved: boolean }> {
    return api.post<{ approved: boolean }>(`/api/workspaces/${workspaceId}/bot-access-requests/${id}/approve`, {})
  },

  /**
   * Deny a request. Race-honest like approve: `denied` is `false` when it was
   * already terminal.
   */
  async deny(workspaceId: string, id: string): Promise<{ denied: boolean }> {
    return api.post<{ denied: boolean }>(`/api/workspaces/${workspaceId}/bot-access-requests/${id}/deny`, {})
  },
}
