import { api } from "./client"
import type { DocPostUpdateResult, DocState, DocUpdatesResponse } from "@threahq/types"

/** Collaborative doc streams: full state, the update log, and Yjs writes (base64). */
export const docsApi = {
  /** With `stateVector` (base64), `state` carries only what that vector lacks. */
  get(workspaceId: string, docId: string, stateVector?: string): Promise<DocState> {
    const query = stateVector === undefined ? "" : `?sv=${encodeURIComponent(stateVector)}`
    return api.get<DocState>(`/api/workspaces/${workspaceId}/docs/${docId}${query}`)
  },

  listUpdates(workspaceId: string, docId: string, after: number): Promise<DocUpdatesResponse> {
    return api.get<DocUpdatesResponse>(`/api/workspaces/${workspaceId}/docs/${docId}/updates?after=${after}`)
  },

  postUpdate(workspaceId: string, docId: string, update: string): Promise<DocPostUpdateResult> {
    return api.post<DocPostUpdateResult>(`/api/workspaces/${workspaceId}/docs/${docId}/updates`, { update })
  },
}
