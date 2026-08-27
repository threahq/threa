import { api, API_BASE, parseApiError } from "./client"
import { BOOTSTRAP_FRESH_PARAM } from "@/lib/sw-bootstrap-prefetch"
import type {
  Workspace,
  WorkspaceBootstrap,
  User,
  CreateWorkspaceInput,
  CompleteUserSetupInput,
  PendingInvitation,
  UserApiKey,
  CreateUserApiKeyResponse,
  WorkspacePermissionSlug,
  MarkAllAsReadResponse,
  ActiveAgentSessionsResponse,
} from "@threa/types"

export type { WorkspaceBootstrap, CreateWorkspaceInput }

export interface WorkspaceListResult {
  workspaces: Workspace[]
  pendingInvitations: PendingInvitation[]
}

export const workspacesApi = {
  async list(): Promise<WorkspaceListResult> {
    return api.get<WorkspaceListResult>("/api/workspaces")
  },

  async acceptInvitation(invitationId: string): Promise<{ workspaceId: string }> {
    return api.post<{ workspaceId: string }>(`/api/invitations/${invitationId}/accept`)
  },

  async listRegions(): Promise<string[]> {
    const res = await api.get<{ regions: string[] }>("/api/regions")
    return res.regions
  },

  async get(workspaceId: string): Promise<Workspace> {
    const res = await api.get<{ workspace: Workspace }>(`/api/workspaces/${workspaceId}`)
    return res.workspace
  },

  /**
   * `fresh` forbids the service worker's lock-time bootstrap snapshot from
   * answering this request — it drops the entry and goes to the network. Set it
   * whenever the caller is about to treat the response as the authority for
   * everything at or below a separately-read sync head: a snapshot captured
   * before the device went away would silently be older than that head, and
   * every entry between the two would be stranded.
   */
  async bootstrap(workspaceId: string, opts?: { fresh?: boolean }): Promise<WorkspaceBootstrap> {
    // Both signals: the query flag survives every engine's request handling,
    // `no-store` also keeps the HTTP cache out of it.
    const path = `/api/workspaces/${workspaceId}/bootstrap${opts?.fresh ? `?${BOOTSTRAP_FRESH_PARAM}=1` : ""}`
    const res = await api.get<{ data: WorkspaceBootstrap }>(path, opts?.fresh ? { cache: "no-store" } : undefined)
    return res.data
  },

  async activeAgentSessions(workspaceId: string): Promise<ActiveAgentSessionsResponse> {
    return api.get<ActiveAgentSessionsResponse>(`/api/workspaces/${workspaceId}/agent-activity`, { cache: "no-store" })
  },

  async create(data: CreateWorkspaceInput): Promise<Workspace> {
    const res = await api.post<{ workspace: Workspace }>("/api/workspaces", data)
    return res.workspace
  },

  async markAllAsRead(workspaceId: string): Promise<MarkAllAsReadResponse> {
    return api.post<MarkAllAsReadResponse>(`/api/workspaces/${workspaceId}/streams/read-all`)
  },

  async completeUserSetup(workspaceId: string, data: CompleteUserSetupInput): Promise<User> {
    const res = await api.post<{ user?: User }>(`/api/workspaces/${workspaceId}/setup`, data)
    if (!res.user) {
      throw new Error("Setup response missing user payload")
    }
    return res.user
  },

  async checkSlugAvailable(workspaceId: string, slug: string, signal?: AbortSignal): Promise<boolean> {
    const res = await api.get<{ available: boolean }>(
      `/api/workspaces/${workspaceId}/slug-available?slug=${encodeURIComponent(slug)}`,
      { signal }
    )
    return res.available
  },

  async updateProfile(
    workspaceId: string,
    data: {
      name?: string
      description?: string | null
      pronouns?: string | null
      phone?: string | null
      githubUsername?: string | null
    }
  ): Promise<User> {
    const res = await api.patch<{ user?: User }>(`/api/workspaces/${workspaceId}/profile`, data)
    if (!res.user) {
      throw new Error("Profile response missing user payload")
    }
    return res.user
  },

  async setStatus(
    workspaceId: string,
    data: { emoji: string | null; text: string | null; expiresAt: string | null; pausesNotifications: boolean }
  ): Promise<User> {
    const res = await api.put<{ user?: User }>(`/api/workspaces/${workspaceId}/status`, data)
    if (!res.user) {
      throw new Error("Status response missing user payload")
    }
    return res.user
  },

  async clearStatus(workspaceId: string): Promise<User> {
    const res = await api.delete<{ user?: User }>(`/api/workspaces/${workspaceId}/status`)
    if (!res.user) {
      throw new Error("Status response missing user payload")
    }
    return res.user
  },

  /** Pause notifications: `until` is an ISO instant for a timed pause, or null for indefinite. */
  async pauseNotifications(workspaceId: string, until: string | null): Promise<User> {
    const res = await api.put<{ user?: User }>(`/api/workspaces/${workspaceId}/notifications/pause`, { until })
    if (!res.user) {
      throw new Error("Notification pause response missing user payload")
    }
    return res.user
  },

  async resumeNotifications(workspaceId: string): Promise<User> {
    const res = await api.delete<{ user?: User }>(`/api/workspaces/${workspaceId}/notifications/pause`)
    if (!res.user) {
      throw new Error("Notification pause response missing user payload")
    }
    return res.user
  },

  async uploadAvatar(workspaceId: string, file: File): Promise<User> {
    const formData = new FormData()
    formData.append("avatar", file)

    const response = await fetch(`${API_BASE}/api/workspaces/${workspaceId}/profile/avatar`, {
      method: "POST",
      body: formData,
      credentials: "include",
    })

    if (!response.ok) {
      throw await parseApiError(response, { code: "AVATAR_UPLOAD_ERROR", message: "Avatar upload failed" })
    }

    const body = await response.json()
    if (!body.user) {
      throw new Error("Avatar response missing user payload")
    }
    return body.user
  },

  async removeAvatar(workspaceId: string): Promise<User> {
    const res = await api.delete<{ user?: User }>(`/api/workspaces/${workspaceId}/profile/avatar`)
    if (!res.user) {
      throw new Error("Avatar response missing user payload")
    }
    return res.user
  },

  async listUserApiKeys(workspaceId: string): Promise<UserApiKey[]> {
    const res = await api.get<{ keys: UserApiKey[] }>(`/api/workspaces/${workspaceId}/user-api-keys`)
    return res.keys
  },

  async createUserApiKey(
    workspaceId: string,
    params: { name: string; scopes: WorkspacePermissionSlug[]; expiresAt?: string | null }
  ): Promise<CreateUserApiKeyResponse> {
    return api.post<CreateUserApiKeyResponse>(`/api/workspaces/${workspaceId}/user-api-keys`, params)
  },

  async updateUserApiKeyScopes(
    workspaceId: string,
    keyId: string,
    scopes: WorkspacePermissionSlug[]
  ): Promise<UserApiKey> {
    const res = await api.patch<{ key: UserApiKey }>(`/api/workspaces/${workspaceId}/user-api-keys/${keyId}`, {
      scopes,
    })
    return res.key
  },

  async updateUserApiKeyVersion(workspaceId: string, keyId: string, apiVersion: string | null): Promise<UserApiKey> {
    const res = await api.patch<{ key: UserApiKey }>(`/api/workspaces/${workspaceId}/user-api-keys/${keyId}`, {
      apiVersion,
    })
    return res.key
  },

  async revokeUserApiKey(workspaceId: string, keyId: string): Promise<void> {
    await api.post(`/api/workspaces/${workspaceId}/user-api-keys/${keyId}/revoke`)
  },
}
