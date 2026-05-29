import { api } from "./client"
import type { SidebarConfig } from "@threa/types"

export const sidebarConfigApi = {
  async get(workspaceId: string): Promise<SidebarConfig> {
    const res = await api.get<{ sidebarConfig: SidebarConfig }>(`/api/workspaces/${workspaceId}/sidebar-config`)
    return res.sidebarConfig
  },

  async update(workspaceId: string, config: SidebarConfig): Promise<SidebarConfig> {
    const res = await api.patch<{ sidebarConfig: SidebarConfig }>(
      `/api/workspaces/${workspaceId}/sidebar-config`,
      config
    )
    return res.sidebarConfig
  },
}
