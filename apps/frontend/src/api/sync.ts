import { api } from "./client"
import type { SyncCatchUpResponse } from "@threa/types"

export const syncApi = {
  /**
   * One page of sync-log entries after the cursor, filtered server-side to
   * what this user may see. Page until `entries` comes back empty — `head`
   * is a workspace-global freshness hint, never a cursor target.
   */
  async catchUp(
    workspaceId: string,
    params: { after: string; limit?: number },
    signal?: AbortSignal
  ): Promise<SyncCatchUpResponse> {
    const query = new URLSearchParams({ after: params.after })
    if (params.limit !== undefined) query.set("limit", String(params.limit))
    return api.get<SyncCatchUpResponse>(`/api/workspaces/${workspaceId}/sync?${query.toString()}`, { signal })
  },
}
