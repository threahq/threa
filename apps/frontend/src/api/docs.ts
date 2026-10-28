import { api } from "./client"
import type {
  DocBacklinksResponse,
  DocListResponse,
  DocMovePreviewResponse,
  DocPostUpdateResult,
  DocSectionResponse,
  DocState,
  DocThreadsResponse,
  DocUpdatesResponse,
  MoveDocInput,
  Stream,
} from "@threahq/types"

export const docKeys = {
  list: (workspaceId: string) => ["docList", workspaceId] as const,
  threads: (workspaceId: string, docId: string) => ["docThreads", workspaceId, docId] as const,
  section: (workspaceId: string, docId: string, blockId: string) =>
    ["docSection", workspaceId, docId, blockId] as const,
  allBacklinks: (workspaceId: string) => ["docBacklinks", workspaceId] as const,
  backlinks: (workspaceId: string, docId: string) => [...docKeys.allBacklinks(workspaceId), docId] as const,
}

/** Collaborative doc streams: full state, the update log, and Yjs writes (base64). */
export const docsApi = {
  /** Every live doc the viewer can read, with who edited it and when, last edited first. */
  list(workspaceId: string): Promise<DocListResponse> {
    return api.get<DocListResponse>(`/api/workspaces/${workspaceId}/docs`)
  },

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

  listThreads(workspaceId: string, docId: string): Promise<DocThreadsResponse> {
    return api.get<DocThreadsResponse>(`/api/workspaces/${workspaceId}/docs/${docId}/threads`)
  },

  getSection(workspaceId: string, docId: string, blockId: string): Promise<DocSectionResponse> {
    return api.get<DocSectionResponse>(`/api/workspaces/${workspaceId}/docs/${docId}/sections/${blockId}`)
  },

  listBacklinks(workspaceId: string, docId: string): Promise<DocBacklinksResponse> {
    return api.get<DocBacklinksResponse>(`/api/workspaces/${workspaceId}/docs/${docId}/backlinks`)
  },

  /** How many users the move would take read access from, and give it to. */
  previewMove(workspaceId: string, docId: string, toStreamId: string): Promise<DocMovePreviewResponse> {
    return api.get<DocMovePreviewResponse>(
      `/api/workspaces/${workspaceId}/docs/${docId}/move-preview?toStreamId=${encodeURIComponent(toStreamId)}`
    )
  },

  move(workspaceId: string, docId: string, input: MoveDocInput): Promise<{ stream: Stream }> {
    return api.post<{ stream: Stream }>(`/api/workspaces/${workspaceId}/docs/${docId}/move`, input)
  },
}
