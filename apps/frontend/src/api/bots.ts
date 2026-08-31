import { api, postAvatarUpload } from "./client"
import type { Bot, BotApiKey, BotTrait, CreateBotApiKeyResponse, WorkspacePermissionSlug } from "@threa/types"

export interface CreateBotInput {
  type?: "shared" | "personal"
  name: string
  slug: string
  description?: string | null
  avatarEmoji?: string | null
  traits?: BotTrait[]
  readsAsOwner?: boolean
}

export interface UpdateBotInput {
  name?: string
  slug?: string
  description?: string | null
  avatarEmoji?: string | null
  traits?: BotTrait[]
  readsAsOwner?: boolean
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

  async updateKeyVersion(
    workspaceId: string,
    botId: string,
    keyId: string,
    apiVersion: string | null
  ): Promise<BotApiKey> {
    const res = await api.patch<{ data: BotApiKey }>(`/api/workspaces/${workspaceId}/bots/${botId}/keys/${keyId}`, {
      apiVersion,
    })
    return res.data
  },

  async revokeKey(workspaceId: string, botId: string, keyId: string): Promise<void> {
    await api.post(`/api/workspaces/${workspaceId}/bots/${botId}/keys/${keyId}/revoke`)
  },

  async uploadAvatar(workspaceId: string, botId: string, file: File): Promise<Bot> {
    const { data } = await postAvatarUpload<{ data: Bot }>(`/api/workspaces/${workspaceId}/bots/${botId}/avatar`, file)
    return data
  },

  async removeAvatar(workspaceId: string, botId: string): Promise<Bot> {
    const res = await api.delete<{ data: Bot }>(`/api/workspaces/${workspaceId}/bots/${botId}/avatar`)
    return res.data
  },

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

  async listStreamBots(workspaceId: string, streamId: string): Promise<string[]> {
    const res = await api.get<{ data: string[] }>(`/api/workspaces/${workspaceId}/streams/${streamId}/bots`)
    return res.data
  },
}
