import { api } from "./client"
import type { DocPostUpdateResult, DocState, DocUpdateView } from "@threahq/types"

/** Collaborative doc streams: full state, the update log, and Yjs writes (base64). */
export const docsApi = {
  get(workspaceId: string, docId: string): Promise<DocState> {
    return api.get<DocState>(`/api/workspaces/${workspaceId}/docs/${docId}`)
  },

  listUpdates(workspaceId: string, docId: string, after: number): Promise<{ updates: DocUpdateView[] }> {
    return api.get<{ updates: DocUpdateView[] }>(`/api/workspaces/${workspaceId}/docs/${docId}/updates?after=${after}`)
  },

  postUpdate(workspaceId: string, docId: string, update: string): Promise<DocPostUpdateResult> {
    return api.post<DocPostUpdateResult>(`/api/workspaces/${workspaceId}/docs/${docId}/updates`, { update })
  },
}
