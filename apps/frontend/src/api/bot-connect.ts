import { api } from "./client"

export interface BotConnectLookup {
  userCode: string
  requestedName: string | null
  requestedHost: string | null
  expiresAt: string
}

export interface ApproveBotConnectInput {
  code: string
  workspaceId: string
  workspaceName: string
  botId: string
  botSlug: string
  /** Space-separated scopes the key carries, echoed to the device as the OAuth `scope`. */
  scope: string
  apiKey: string
}

/**
 * The browser half of the OAuth device grant behind `threa-bot connect`:
 * session-authenticated, served by the control plane. The device side is
 * `/api/oauth/device_authorization` + `/api/oauth/token`.
 */
export const botConnectApi = {
  async lookup(code: string): Promise<BotConnectLookup> {
    return api.get<BotConnectLookup>(`/api/bot-connect/lookup?code=${encodeURIComponent(code)}`)
  },

  async approve(input: ApproveBotConnectInput): Promise<void> {
    await api.post("/api/bot-connect/approve", input)
  },

  async deny(code: string): Promise<void> {
    await api.post("/api/bot-connect/deny", { code })
  },
}
