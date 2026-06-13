import { api } from "./client"
import type { DraftListResponse, UpsertDraftInput, UpsertDraftResponse } from "@threa/types"

/**
 * Centralized-draft REST client (Stage 3). Drafts are user-scoped on the
 * backend (auth resolves the owner), so no user id is sent — only the
 * workspace and the draft id.
 *
 * `upsert` is the debounced background mirror of a local draft; `delete` clears
 * a discarded draft. Both are driven from the offline operation queue with
 * silent retry — callers never surface their errors (a failed remote draft save
 * is invisible by design, the local copy stands). Resolve-on-send lands in
 * Stage 4.
 */
export const draftsApi = {
  /** Bootstrap seed: every live draft owned by the viewer in this workspace. */
  async list(workspaceId: string): Promise<DraftListResponse> {
    return api.get<DraftListResponse>(`/api/workspaces/${workspaceId}/drafts`)
  },

  /**
   * Mirror a draft to the backend. The server CAS-updates on `expectedVersion`
   * and SPLITS (mints a new id for the incoming content, leaving the existing
   * row for the other device) on a mismatch — the caller migrates its local id
   * to `response.draft.id` when `response.split` is true.
   */
  async upsert(workspaceId: string, id: string, input: UpsertDraftInput): Promise<UpsertDraftResponse> {
    return api.put<UpsertDraftResponse>(`/api/workspaces/${workspaceId}/drafts/${id}`, input)
  },

  /** Unconditional soft-delete (idempotent on an already-gone draft). */
  async delete(workspaceId: string, id: string): Promise<void> {
    await api.delete<{ ok: true }>(`/api/workspaces/${workspaceId}/drafts/${id}`)
  },
}
