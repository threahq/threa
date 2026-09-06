import { api } from "./client"
import type { AgentSessionWithSteps } from "@threahq/types"

export const agentSessionsApi = {
  async getSession(workspaceId: string, sessionId: string): Promise<AgentSessionWithSteps> {
    return api.get<AgentSessionWithSteps>(`/api/workspaces/${workspaceId}/agent-sessions/${sessionId}`)
  },
}
