import type { AuthorType, KnowledgeType, Memo, MemoType } from "@threa/types"
import api from "./client"

export interface MemoExplorerStreamRef {
  id: string
  type: string
  name: string | null
}

export interface MemoExplorerResult {
  memo: Memo
  distance: number
  sourceStream: MemoExplorerStreamRef | null
  rootStream: MemoExplorerStreamRef | null
}

export interface MemoExplorerSourceMessage {
  id: string
  streamId: string
  streamName: string
  authorId: string
  authorType: AuthorType
  authorName: string
  content: string
  createdAt: string
}

export interface MemoExplorerDetail extends MemoExplorerResult {
  sourceMessages: MemoExplorerSourceMessage[]
}

export interface MemoSearchFilters {
  in?: string[]
  memoType?: MemoType[]
  knowledgeType?: KnowledgeType[]
  tags?: string[]
  before?: string
  after?: string
}

export interface MemoSearchRequest {
  query?: string
  exact?: boolean
  limit?: number
  /**
   * Access anchor: the stream the search is being run from (e.g. the `/memo`
   * picker in a composer). Not a "memos in this stream" filter — when set,
   * results are scoped to what is shareable into that stream so memos from
   * unrelated streams can't leak in. May be a thread or its root; the backend
   * resolves the root. Omit for the memory explorer, which browses everything
   * the user can access.
   */
  anchorStreamId?: string
  filters?: MemoSearchFilters
}

export interface MemoSearchResponse {
  results: MemoExplorerResult[]
}

export interface MemoDetailResponse {
  memo: MemoExplorerDetail
}

export async function searchMemos(workspaceId: string, request: MemoSearchRequest): Promise<MemoSearchResponse> {
  const body = {
    query: request.query ?? "",
    exact: request.exact,
    limit: request.limit,
    anchorStreamId: request.anchorStreamId,
    in: request.filters?.in,
    memoType: request.filters?.memoType,
    knowledgeType: request.filters?.knowledgeType,
    tags: request.filters?.tags,
    before: request.filters?.before,
    after: request.filters?.after,
  }

  return api.post<MemoSearchResponse>(`/api/workspaces/${workspaceId}/memos/search`, body)
}

export async function getMemo(workspaceId: string, memoId: string): Promise<MemoDetailResponse> {
  return api.get<MemoDetailResponse>(`/api/workspaces/${workspaceId}/memos/${memoId}`)
}
