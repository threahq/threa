import { api } from "./client"
import type { WorkspaceSettings, UpdateWorkspaceSettingsInput } from "@threa/types"

export const workspaceSettingsApi = {
  async get(workspaceId: string): Promise<WorkspaceSettings> {
    const res = await api.get<{ settings: WorkspaceSettings }>(`/api/workspaces/${workspaceId}/workspace-settings`)
    return res.settings
  },

  async update(workspaceId: string, input: UpdateWorkspaceSettingsInput): Promise<WorkspaceSettings> {
    const res = await api.patch<{ settings: WorkspaceSettings }>(
      `/api/workspaces/${workspaceId}/workspace-settings`,
      input
    )
    return res.settings
  },
}
