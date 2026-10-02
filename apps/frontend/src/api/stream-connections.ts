import { ApiError, api } from "./client"
import {
  StreamConnectionErrorCodes,
  type AcceptStreamConnectionInput,
  type CreateStreamConnectionInviteResponse,
  type ListStreamConnectionsResponse,
  type StreamConnection,
  type StreamConnectionLookupResponse,
  type StreamConnectionResponse,
} from "@threahq/types"

export const streamConnectionsApi = {
  async list(workspaceId: string, streamId: string): Promise<StreamConnection[]> {
    const res = await api.get<ListStreamConnectionsResponse>(
      `/api/workspaces/${workspaceId}/streams/${streamId}/connections`
    )
    return res.connections
  },

  createInvite(workspaceId: string, streamId: string): Promise<CreateStreamConnectionInviteResponse> {
    return api.post<CreateStreamConnectionInviteResponse>(
      `/api/workspaces/${workspaceId}/streams/${streamId}/connection-invites`
    )
  },

  async revoke(workspaceId: string, connectionId: string): Promise<StreamConnection> {
    const res = await api.post<StreamConnectionResponse>(
      `/api/workspaces/${workspaceId}/stream-connections/${connectionId}/revoke`
    )
    return res.connection
  },

  /** False when the viewer isn't an admin there or the workspace has sharing switched off. */
  async canAccept(workspaceId: string): Promise<boolean> {
    try {
      // The picker waits on every probe, so a slow region can't hold it for the default 20s.
      await api.get<void>(`/api/workspaces/${workspaceId}/stream-connections/can-accept`, { timeoutMs: 5_000 })
      return true
    } catch (error) {
      if (ApiError.isApiError(error) && (error.status === 403 || error.code === StreamConnectionErrorCodes.DISABLED)) {
        return false
      }
      throw error
    }
  },

  async accept(workspaceId: string, input: AcceptStreamConnectionInput): Promise<StreamConnection> {
    const res = await api.post<StreamConnectionResponse>(
      `/api/workspaces/${workspaceId}/stream-connections/accept`,
      input
    )
    return res.connection
  },

  /** Control-plane route: the invite page has no workspace yet. */
  lookup(token: string): Promise<StreamConnectionLookupResponse> {
    return api.get<StreamConnectionLookupResponse>(`/api/stream-connections/lookup?token=${encodeURIComponent(token)}`)
  },
}
