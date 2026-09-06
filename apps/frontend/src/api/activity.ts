import { api } from "./client"
import type { Activity } from "@threahq/types"

export interface ListActivityParams {
  limit?: number
  cursor?: string
  unreadOnly?: boolean
  mineOnly?: boolean
  othersOnly?: boolean
}

export const activityApi = {
  async list(workspaceId: string, params?: ListActivityParams): Promise<Activity[]> {
    const query = new URLSearchParams()
    if (params?.limit) query.set("limit", String(params.limit))
    if (params?.cursor) query.set("cursor", params.cursor)
    if (params?.unreadOnly) query.set("unreadOnly", "true")
    if (params?.mineOnly) query.set("mineOnly", "true")
    if (params?.othersOnly) query.set("othersOnly", "true")

    const qs = query.toString()
    const path = `/api/workspaces/${workspaceId}/activity${qs ? `?${qs}` : ""}`
    const res = await api.get<{ activities: Activity[] }>(path)
    return res.activities
  },

  async markAsRead(workspaceId: string, activityId: string): Promise<void> {
    await api.post(`/api/workspaces/${workspaceId}/activity/${activityId}/read`)
  },

  async markAllAsRead(workspaceId: string): Promise<void> {
    await api.post(`/api/workspaces/${workspaceId}/activity/read`)
  },
}
