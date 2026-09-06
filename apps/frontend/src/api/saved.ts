import { api } from "./client"
import type {
  SavedMessageView,
  SavedMessageListResponse,
  SavedStatus,
  SaveMessageInput,
  UpdateSavedMessageInput,
} from "@threahq/types"

export interface ListSavedParams {
  status: SavedStatus
  limit?: number
  cursor?: string
}

export const savedApi = {
  async list(workspaceId: string, params: ListSavedParams): Promise<SavedMessageListResponse> {
    const query = new URLSearchParams()
    query.set("status", params.status)
    if (params.limit) query.set("limit", String(params.limit))
    if (params.cursor) query.set("cursor", params.cursor)

    return api.get<SavedMessageListResponse>(`/api/workspaces/${workspaceId}/saved?${query.toString()}`)
  },

  async create(workspaceId: string, input: SaveMessageInput): Promise<SavedMessageView> {
    const res = await api.post<{ saved: SavedMessageView }>(`/api/workspaces/${workspaceId}/saved`, input)
    return res.saved
  },

  async update(workspaceId: string, savedId: string, input: UpdateSavedMessageInput): Promise<SavedMessageView> {
    const res = await api.patch<{ saved: SavedMessageView }>(`/api/workspaces/${workspaceId}/saved/${savedId}`, input)
    return res.saved
  },

  async delete(workspaceId: string, savedId: string): Promise<void> {
    await api.delete<{ ok: true }>(`/api/workspaces/${workspaceId}/saved/${savedId}`)
  },
}
