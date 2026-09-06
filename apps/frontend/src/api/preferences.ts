import { api } from "./client"
import type { UserPreferences, UpdateUserPreferencesInput } from "@threahq/types"

export const preferencesApi = {
  async get(workspaceId: string): Promise<UserPreferences> {
    const res = await api.get<{ preferences: UserPreferences }>(`/api/workspaces/${workspaceId}/preferences`)
    return res.preferences
  },

  async update(workspaceId: string, input: UpdateUserPreferencesInput): Promise<UserPreferences> {
    const res = await api.patch<{ preferences: UserPreferences }>(`/api/workspaces/${workspaceId}/preferences`, input)
    return res.preferences
  },
}
