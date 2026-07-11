import { api } from "./client"
import type { ListWorkspacePersonasResponse, UpdatePersonaConfigInput, WorkspacePersonaSummary } from "@threa/types"

export const personasApi = {
  async list(workspaceId: string): Promise<ListWorkspacePersonasResponse> {
    return api.get<ListWorkspacePersonasResponse>(`/api/workspaces/${workspaceId}/personas`)
  },

  async updateConfig(
    workspaceId: string,
    personaId: string,
    input: UpdatePersonaConfigInput
  ): Promise<WorkspacePersonaSummary> {
    const res = await api.patch<{ persona: WorkspacePersonaSummary }>(
      `/api/workspaces/${workspaceId}/personas/${personaId}/config`,
      input
    )
    return res.persona
  },
}
