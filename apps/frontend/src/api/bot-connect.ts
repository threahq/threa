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
  apiKey: string
}

/** The `threa-bot connect` approval half: session-authenticated, served by the control plane. */
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
