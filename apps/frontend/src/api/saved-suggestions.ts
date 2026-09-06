import { api } from "./client"
import type {
  SavedSuggestionView,
  SavedSuggestionListResponse,
  SavedSuggestionStatus,
  AcceptSavedSuggestionResponse,
} from "@threahq/types"

export interface ListSuggestionsParams {
  status: SavedSuggestionStatus
  limit?: number
  cursor?: string
}

export const savedSuggestionsApi = {
  async list(workspaceId: string, params: ListSuggestionsParams): Promise<SavedSuggestionListResponse> {
    const query = new URLSearchParams()
    query.set("status", params.status)
    if (params.limit) query.set("limit", String(params.limit))
    if (params.cursor) query.set("cursor", params.cursor)
    return api.get<SavedSuggestionListResponse>(`/api/workspaces/${workspaceId}/saved/suggestions?${query.toString()}`)
  },

  async accept(workspaceId: string, suggestionId: string): Promise<AcceptSavedSuggestionResponse> {
    return api.post<AcceptSavedSuggestionResponse>(
      `/api/workspaces/${workspaceId}/saved/suggestions/${suggestionId}/accept`,
      {}
    )
  },

  async dismiss(workspaceId: string, suggestionId: string): Promise<SavedSuggestionView> {
    const res = await api.post<{ suggestion: SavedSuggestionView }>(
      `/api/workspaces/${workspaceId}/saved/suggestions/${suggestionId}/dismiss`,
      {}
    )
    return res.suggestion
  },
}
