import { api } from "./client"
import type { WorkspaceRoleSlug } from "@threahq/types"

export const workspaceMembersApi = {
  async changeRole(workspaceId: string, userId: string, roleSlug: WorkspaceRoleSlug): Promise<void> {
    await api.post(`/api/workspaces/${workspaceId}/users/${userId}/role`, { roleSlug })
  },

  async remove(workspaceId: string, userId: string): Promise<void> {
    await api.delete(`/api/workspaces/${workspaceId}/users/${userId}`)
  },
}
