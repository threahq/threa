import { api } from "./client"
import type {
  DeleteDraftInput,
  DraftListResponse,
  ResolveDraftInput,
  ResolveDraftResponse,
  UpsertDraftInput,
  UpsertDraftResponse,
} from "@threahq/types"

/**
 * Centralized-draft REST client. Drafts are user-scoped on the backend (auth
 * resolves the owner), so no user id is sent — only the workspace and the draft
 * id.
 *
 * `upsert` is the debounced background mirror of a local draft; `resolve` clears
 * a draft CAS-safely after its message sends (a drifted copy survives); `delete`
 * is an unconditional discard. All are driven from the offline operation queue
 * with silent retry — callers never surface their errors (a failed remote draft
 * save is invisible by design, the local copy stands).
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

  /**
   * Resolve-on-send: CAS soft-delete guarded by `expectedVersion` plus this
   * device's superseded write ids. Unrelated drift survives as a stash entry
   * instead of being collaterally destroyed (`response.resolved` is false in
   * that case).
   */
  async resolve(workspaceId: string, id: string, input: ResolveDraftInput): Promise<ResolveDraftResponse> {
    return api.post<ResolveDraftResponse>(`/api/workspaces/${workspaceId}/drafts/${id}/resolve`, input)
  },

  /**
   * Unconditional soft-delete (idempotent on an already-gone draft). The body
   * carries this device's in-flight write ids so a push that lands after the
   * tombstone is recognized as discarded content and dropped, not resurrected.
   */
  async delete(workspaceId: string, id: string, input?: DeleteDraftInput): Promise<void> {
    await api.delete<{ ok: true }>(`/api/workspaces/${workspaceId}/drafts/${id}`, {
      body: input ? JSON.stringify(input) : undefined,
    })
  },
}
