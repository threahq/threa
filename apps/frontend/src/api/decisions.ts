import type { DecisionRequest, EnclaveStreamEnvelope } from "@threahq/types"
import { api } from "./client"

export interface ResolveDecisionInput {
  optionId: string
  note?: string
  /**
   * The note on a sealed card, sealed client-side under the stream's current SSK
   * and bound to `streamId|decision-note|decisionId|decidedBy`. A sealed card
   * takes only this, a plaintext card only `note` (INV-E1) — the backend rejects
   * the mismatch rather than storing a note the other half can't read.
   */
  sealedNote?: { ciphertext: string; envelope: EnclaveStreamEnvelope }
  /** The version the resolver's card was showing — the CAS token (INV-66). */
  version: number
}

/**
 * Decision requests (Hermes): a bot runtime puts a call it cannot make to its
 * human on the stream timeline, and the card's option buttons resolve it.
 *
 * Unlike the bot-access approve/deny pair, resolve is not race-honest: a lost
 * CAS race throws an `ApiError` with status 409 and code `DECISION_NOT_OPEN`,
 * whose `details` carry the winning row, which the card reads off the typed
 * error, never off the message text.
 */
export const decisionsApi = {
  async resolve(workspaceId: string, id: string, input: ResolveDecisionInput): Promise<{ decision: DecisionRequest }> {
    return api.post<{ decision: DecisionRequest }>(`/api/workspaces/${workspaceId}/decisions/${id}/resolve`, input)
  },
}
