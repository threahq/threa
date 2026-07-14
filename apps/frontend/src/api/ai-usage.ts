import { api } from "./client"
import type { AIUsageResponse, AIRecentUsageResponse, AIBudgetResponse, UpdateAIBudgetInput } from "@threa/types"

// The usage dashboard's day buckets and month window follow the viewer's
// device timezone (INV-42); the backend draws the date lines server-side.
function tzQuery(): string {
  return `?tz=${encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone)}`
}

export const aiUsageApi = {
  async getUsage(workspaceId: string): Promise<AIUsageResponse> {
    return api.get<AIUsageResponse>(`/api/workspaces/${workspaceId}/ai-usage${tzQuery()}`)
  },

  async getRecentUsage(workspaceId: string, limit?: number): Promise<AIRecentUsageResponse> {
    const query = limit ? `?limit=${limit}` : ""
    return api.get<AIRecentUsageResponse>(`/api/workspaces/${workspaceId}/ai-usage/recent${query}`)
  },

  async getBudget(workspaceId: string): Promise<AIBudgetResponse> {
    return api.get<AIBudgetResponse>(`/api/workspaces/${workspaceId}/ai-budget${tzQuery()}`)
  },

  async updateBudget(workspaceId: string, input: UpdateAIBudgetInput): Promise<AIBudgetResponse> {
    return api.put<AIBudgetResponse>(`/api/workspaces/${workspaceId}/ai-budget${tzQuery()}`, input)
  },
}
