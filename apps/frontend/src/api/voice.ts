import { api } from "./client"

export interface VoiceSession {
  voiceSessionId: string
  model: string
  provider: string
  region: string
  expiresAt: string
  /** Hard cap after which the backend force-stops the take, in ms. */
  maxDurationMs: number
}

export interface CreateVoiceSessionInput {
  model?: string
  language?: string
}

export const voiceApi = {
  createSession(workspaceId: string, data: CreateVoiceSessionInput = {}): Promise<VoiceSession> {
    return api.post<VoiceSession>(`/api/workspaces/${workspaceId}/voice/sessions`, data)
  },

  abortSession(workspaceId: string, sessionId: string): Promise<void> {
    return api.delete(`/api/workspaces/${workspaceId}/voice/sessions/${sessionId}`)
  },
}
