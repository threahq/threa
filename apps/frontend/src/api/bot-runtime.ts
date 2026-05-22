import { api } from "./client"
import type { BotRuntimeStatus } from "@threa/types"

export interface BotRuntimePresence {
  botId: string
  runtimeKind: string
  instanceId: string
  displayName: string | null
  status: BotRuntimeStatus
  acceptingInvocations: boolean
  statusText: string | null
  lastSeenAt: string
}

export const botRuntimeApi = {
  async getPresence(workspaceId: string, streamId: string): Promise<Record<string, BotRuntimePresence | null>> {
    const res = await api.get<{ data: Record<string, BotRuntimePresence | null> }>(
      `/api/workspaces/${workspaceId}/streams/${streamId}/bot-runtime-presence`
    )
    return res.data
  },
}
