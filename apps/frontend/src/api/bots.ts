import { api, API_BASE, parseApiError } from "./client"
import type { Bot, BotApiKey, CreateBotApiKeyResponse, WorkspacePermissionSlug } from "@threa/types"

export interface CreateBotInput {
  type?: "shared" | "personal"
  name: string
  slug: string
  description?: string | null
  avatarEmoji?: string | null
}

export interface UpdateBotInput {
  name?: string
  slug?: string
  description?: string | null
  avatarEmoji?: string | null
}

export interface CreateBotKeyInput {
  name: string
  scopes: string[]
  expiresAt?: string | null
}

export const botsApi = {
  async list(workspaceId: string): Promise<Bot[]> {
    const res = await api.get<{ data: Bot[] }>(`/api/workspaces/${workspaceId}/bots`)
    return res.data
  },

  async get(workspaceId: string, botId: string): Promise<Bot> {
    const res = await api.get<{ data: Bot }>(`/api/workspaces/${workspaceId}/bots/${botId}`)
    return res.data
  },

  async create(workspaceId: string, data: CreateBotInput): Promise<Bot> {
    const res = await api.post<{ data: Bot }>(`/api/workspaces/${workspaceId}/bots`, data)
    return res.data
  },

  async update(workspaceId: string, botId: string, data: UpdateBotInput): Promise<Bot> {
    const res = await api.patch<{ data: Bot }>(`/api/workspaces/${workspaceId}/bots/${botId}`, data)
    return res.data
  },

  async archive(workspaceId: string, botId: string): Promise<Bot> {
    const res = await api.post<{ data: Bot }>(`/api/workspaces/${workspaceId}/bots/${botId}/archive`)
    return res.data
  },

  async restore(workspaceId: string, botId: string): Promise<Bot> {
    const res = await api.post<{ data: Bot }>(`/api/workspaces/${workspaceId}/bots/${botId}/restore`)
    return res.data
  },

  // Key management

  async listKeys(workspaceId: string, botId: string): Promise<BotApiKey[]> {
    const res = await api.get<{ data: BotApiKey[] }>(`/api/workspaces/${workspaceId}/bots/${botId}/keys`)
    return res.data
  },

  async createKey(workspaceId: string, botId: string, data: CreateBotKeyInput): Promise<CreateBotApiKeyResponse> {
    return api.post<CreateBotApiKeyResponse>(`/api/workspaces/${workspaceId}/bots/${botId}/keys`, data)
  },

  async updateKeyScopes(
    workspaceId: string,
    botId: string,
    keyId: string,
    scopes: WorkspacePermissionSlug[]
  ): Promise<BotApiKey> {
    const res = await api.patch<{ data: BotApiKey }>(`/api/workspaces/${workspaceId}/bots/${botId}/keys/${keyId}`, {
      scopes,
    })
    return res.data
  },

  async revokeKey(workspaceId: string, botId: string, keyId: string): Promise<void> {
    await api.post(`/api/workspaces/${workspaceId}/bots/${botId}/keys/${keyId}/revoke`)
  },

  // Avatar management

  async uploadAvatar(workspaceId: string, botId: string, file: File): Promise<Bot> {
    const formData = new FormData()
    formData.append("avatar", file)
    const response = await fetch(`${API_BASE}/api/workspaces/${workspaceId}/bots/${botId}/avatar`, {
      method: "POST",
      credentials: "include",
      body: formData,
    })
    if (!response.ok) {
      throw await parseApiError(response, { code: "AVATAR_UPLOAD_ERROR", message: "Failed to upload avatar" })
    }
    const body = await response.json()
    return body.data
  },

  async removeAvatar(workspaceId: string, botId: string): Promise<Bot> {
    const res = await api.delete<{ data: Bot }>(`/api/workspaces/${workspaceId}/bots/${botId}/avatar`)
    return res.data
  },

  // Channel access

  async listStreamGrants(
    workspaceId: string,
    botId: string
  ): Promise<Array<{ streamId: string; grantedBy: string; grantedAt: string }>> {
    const res = await api.get<{ data: Array<{ streamId: string; grantedBy: string; grantedAt: string }> }>(
      `/api/workspaces/${workspaceId}/bots/${botId}/streams`
    )
    return res.data
  },

  async grantStreamAccess(workspaceId: string, botId: string, streamId: string): Promise<void> {
    await api.post(`/api/workspaces/${workspaceId}/bots/${botId}/streams/${streamId}/grant`)
  },

  async revokeStreamAccess(workspaceId: string, botId: string, streamId: string): Promise<void> {
    await api.delete(`/api/workspaces/${workspaceId}/bots/${botId}/streams/${streamId}/grant`)
  },

  /** List bot IDs that have been granted access to a specific stream */
  async listStreamBots(workspaceId: string, streamId: string): Promise<string[]> {
    const res = await api.get<{ data: string[] }>(`/api/workspaces/${workspaceId}/streams/${streamId}/bots`)
    return res.data
  },
}
