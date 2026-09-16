import type { DecisionRequest } from "@threahq/types"
import { api } from "./client"

export interface ResolveDecisionInput {
  optionId: string
  note?: string
  /** The version the resolver's card was showing — the CAS token (INV-66). */
  version: number
}

/**
 * Decision requests (Hermes): a bot runtime puts a call it cannot make to its
 * human on the stream timeline, and the card's option buttons resolve it.
 *
 * Unlike the bot-access approve/deny pair, resolve is not race-honest: a lost
 * CAS race throws an `ApiError` with status 409 and code `DECISION_NOT_OPEN`,
 * which the card reads off the typed error, never off the message text.
 */
export const decisionsApi = {
  async resolve(workspaceId: string, id: string, input: ResolveDecisionInput): Promise<{ decision: DecisionRequest }> {
    return api.post<{ decision: DecisionRequest }>(`/api/workspaces/${workspaceId}/decisions/${id}/resolve`, input)
  },

  async get(workspaceId: string, id: string): Promise<{ decision: DecisionRequest }> {
    return api.get<{ decision: DecisionRequest }>(`/api/workspaces/${workspaceId}/decisions/${id}`)
  },
}
