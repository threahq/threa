import { api } from "./client"
import type {
  ScheduledMessageView,
  ScheduledMessageListResponse,
  ScheduledMessageStatus,
  ScheduleMessageInput,
  UpdateScheduledMessageInput,
  LockScheduledMessageResponse,
} from "@threahq/types"

export interface ListScheduledParams {
  status: ScheduledMessageStatus
  streamId?: string
  limit?: number
  cursor?: string
}

export const scheduledApi = {
  async list(workspaceId: string, params: ListScheduledParams): Promise<ScheduledMessageListResponse> {
    const query = new URLSearchParams()
    query.set("status", params.status)
    if (params.streamId) query.set("streamId", params.streamId)
    if (params.limit) query.set("limit", String(params.limit))
    if (params.cursor) query.set("cursor", params.cursor)

    return api.get<ScheduledMessageListResponse>(`/api/workspaces/${workspaceId}/scheduled?${query.toString()}`)
  },

  async getById(workspaceId: string, id: string): Promise<ScheduledMessageView> {
    const res = await api.get<{ scheduled: ScheduledMessageView }>(`/api/workspaces/${workspaceId}/scheduled/${id}`)
    return res.scheduled
  },

  async create(workspaceId: string, input: ScheduleMessageInput): Promise<ScheduledMessageView> {
    const res = await api.post<{ scheduled: ScheduledMessageView }>(`/api/workspaces/${workspaceId}/scheduled`, input)
    return res.scheduled
  },

  async update(workspaceId: string, id: string, input: UpdateScheduledMessageInput): Promise<ScheduledMessageView> {
    const res = await api.patch<{ scheduled: ScheduledMessageView }>(
      `/api/workspaces/${workspaceId}/scheduled/${id}`,
      input
    )
    return res.scheduled
  },

  async delete(workspaceId: string, id: string): Promise<void> {
    await api.delete<{ ok: true }>(`/api/workspaces/${workspaceId}/scheduled/${id}`)
  },

  async lockForEdit(workspaceId: string, id: string): Promise<LockScheduledMessageResponse> {
    return api.post<LockScheduledMessageResponse>(`/api/workspaces/${workspaceId}/scheduled/${id}/lock`, {})
  },

  async releaseEditLock(workspaceId: string, id: string): Promise<void> {
    await api.post<{ ok: true }>(`/api/workspaces/${workspaceId}/scheduled/${id}/unlock`, {})
  },

  async sendNow(workspaceId: string, id: string): Promise<ScheduledMessageView> {
    const res = await api.post<{ scheduled: ScheduledMessageView }>(
      `/api/workspaces/${workspaceId}/scheduled/${id}/send-now`,
      {}
    )
    return res.scheduled
  },
}
