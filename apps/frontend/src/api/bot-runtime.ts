import { api } from "./client"
import type { BotRuntimePresenceSummary } from "@threa/types"

export const botRuntimeApi = {
  async getPresence(workspaceId: string, streamId: string): Promise<Record<string, BotRuntimePresenceSummary | null>> {
    const res = await api.get<{ data: Record<string, BotRuntimePresenceSummary | null> }>(
      `/api/workspaces/${workspaceId}/streams/${streamId}/bot-runtime-presence`
    )
    return res.data
  },
}
