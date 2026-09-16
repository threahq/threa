import { api } from "./client"
import type {
  AIUsageResponse,
  AIRecentUsageResponse,
  AIBudgetResponse,
  UpdateAIBudgetInput,
  AIUserLimitsListResponse,
  AIUserLimitsResponse,
  SetAIUserLimitsInput,
} from "@threahq/types"

// The dashboard's day buckets and month window are drawn server-side in the
// timezone the caller names — the viewer's device zone or the workspace's
// reporting zone, whichever they picked. Callers resolve the mode to an IANA
// zone; this module just carries it.
function tzQuery(timezone: string): string {
  return `?tz=${encodeURIComponent(timezone)}`
}

export const aiUsageApi = {
  async getUsage(workspaceId: string, timezone: string): Promise<AIUsageResponse> {
    return api.get<AIUsageResponse>(`/api/workspaces/${workspaceId}/ai-usage${tzQuery(timezone)}`)
  },

  async getRecentUsage(workspaceId: string, limit?: number): Promise<AIRecentUsageResponse> {
    const query = limit ? `?limit=${limit}` : ""
    return api.get<AIRecentUsageResponse>(`/api/workspaces/${workspaceId}/ai-usage/recent${query}`)
  },

  async getBudget(workspaceId: string, timezone: string): Promise<AIBudgetResponse> {
    return api.get<AIBudgetResponse>(`/api/workspaces/${workspaceId}/ai-budget${tzQuery(timezone)}`)
  },

  async updateBudget(workspaceId: string, timezone: string, input: UpdateAIBudgetInput): Promise<AIBudgetResponse> {
    return api.put<AIBudgetResponse>(`/api/workspaces/${workspaceId}/ai-budget${tzQuery(timezone)}`, input)
  },

  async listUserLimits(workspaceId: string): Promise<AIUserLimitsListResponse> {
    return api.get<AIUserLimitsListResponse>(`/api/workspaces/${workspaceId}/ai-budget/users`)
  },

  async setUserLimits(workspaceId: string, userId: string, input: SetAIUserLimitsInput): Promise<AIUserLimitsResponse> {
    return api.put<AIUserLimitsResponse>(`/api/workspaces/${workspaceId}/ai-budget/users/${userId}`, input)
  },

  async resetUserLimits(workspaceId: string, userId: string): Promise<void> {
    await api.delete<void>(`/api/workspaces/${workspaceId}/ai-budget/users/${userId}`)
  },
}
