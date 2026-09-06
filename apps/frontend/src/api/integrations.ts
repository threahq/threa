import { api } from "./client"
import type { GitHubWorkspaceIntegration, LinearWorkspaceIntegration } from "@threahq/types"

export interface GitHubIntegrationResponse {
  configured: boolean
  integrations: GitHubWorkspaceIntegration[]
}

export interface LinearIntegrationResponse {
  configured: boolean
  integration: LinearWorkspaceIntegration | null
}

export const integrationsApi = {
  async getGithub(workspaceId: string): Promise<GitHubIntegrationResponse> {
    return api.get<GitHubIntegrationResponse>(`/api/workspaces/${workspaceId}/integrations/github`)
  },

  async disconnectGithub(workspaceId: string, integrationId: string): Promise<void> {
    await api.delete(`/api/workspaces/${workspaceId}/integrations/github/${integrationId}`)
  },

  async syncGithub(workspaceId: string, integrationId: string): Promise<GitHubIntegrationResponse> {
    return api.post<GitHubIntegrationResponse>(
      `/api/workspaces/${workspaceId}/integrations/github/${integrationId}/sync`
    )
  },

  async getLinear(workspaceId: string): Promise<LinearIntegrationResponse> {
    return api.get<LinearIntegrationResponse>(`/api/workspaces/${workspaceId}/integrations/linear`)
  },

  async disconnectLinear(workspaceId: string): Promise<void> {
    await api.delete(`/api/workspaces/${workspaceId}/integrations/linear`)
  },
}
