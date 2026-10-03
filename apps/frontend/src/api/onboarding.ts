import { api } from "./client"

export const onboardingApi = {
  /** Idempotent: a repeat call returns the same stream; only the first starts the greeting. */
  async meetAriadne(workspaceId: string): Promise<{ streamId: string }> {
    return api.post<{ streamId: string }>(`/api/workspaces/${workspaceId}/onboarding/meet-ariadne`, {})
  },
}
