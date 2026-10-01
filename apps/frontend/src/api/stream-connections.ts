import { api } from "./client"
import type {
  AcceptStreamConnectionInput,
  CreateStreamConnectionInviteResponse,
  ListStreamConnectionsResponse,
  StreamConnection,
  StreamConnectionLookupResponse,
  StreamConnectionResponse,
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

export function streamConnectionInviteUrl(token: string): string {
  return `${window.location.origin}/connections/${token}`
}
