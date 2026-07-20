import api from "./client"
import type { AuthorType, StreamType } from "@threa/types"

export type ArchiveStatus = "active" | "archived"

export interface SearchFilters {
  from?: string // Single author ID
  with?: string[] // User IDs (AND logic)
  in?: string[] // Stream IDs
  type?: StreamType[] // Stream types (OR logic)
  status?: ArchiveStatus[] // Archive status (active, archived)
  before?: string // ISO datetime
  after?: string // ISO datetime
}

export interface SearchRequest {
  query?: string
  phrases?: string[]
  limit?: number
  filters?: SearchFilters
  /** Use exact substring matching (ILIKE) instead of full-text/semantic search */
  exact?: boolean
}

export interface SearchResultItem {
  id: string
  streamId: string
  content: string
  authorId: string
  authorType: AuthorType
  createdAt: string
  rank: number
}

export interface SearchResponse {
  results: SearchResultItem[]
}

export async function searchMessages(workspaceId: string, request: SearchRequest): Promise<SearchResponse> {
  const body = {
    query: request.query ?? "",
    phrases: request.phrases,
    from: request.filters?.from,
    with: request.filters?.with,
    in: request.filters?.in,
    type: request.filters?.type,
    status: request.filters?.status,
    before: request.filters?.before,
    after: request.filters?.after,
    exact: request.exact,
    limit: request.limit,
  }

  return api.post<SearchResponse>(`/api/workspaces/${workspaceId}/search`, body)
}
