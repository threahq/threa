import api from "./client"
import type { AuthorType, ConversationStatus, SearchClickKind, StreamType } from "@threa/types"

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
  /** Rewrite the query into variants and rerank; slower, costs two model calls. */
  deep?: boolean
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

/**
 * A whole discussion whose topic matched the query semantically. `firstMessageId`
 * deep-links into the stream at the start of the discussion; the span and count
 * come from its non-deleted messages.
 */
export interface ConversationSearchResult {
  id: string
  streamId: string
  topicSummary: string | null
  summary: string | null
  status: ConversationStatus
  messageCount: number
  participantIds: string[]
  firstMessageId: string | null
  firstMessageAt: string | null
  lastMessageAt: string | null
  distance: number
}

export interface SearchResponse {
  results: SearchResultItem[]
  /** Empty on exact and keyword-only searches — the conversation leg is semantic. */
  conversations: ConversationSearchResult[]
  /** Set only when the user opted into search query logging (`searchQueryLog` flag); pass it to `recordSearchClick`. */
  queryLogId: string | null
}

export interface SearchClickTarget {
  kind: SearchClickKind
  id: string
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
    deep: request.deep,
  }

  return api.post<SearchResponse>(`/api/workspaces/${workspaceId}/search`, body)
}

/** Attributes the result the user opened to a logged search. Last click wins. */
export async function recordSearchClick(
  workspaceId: string,
  queryLogId: string,
  target: SearchClickTarget
): Promise<void> {
  await api.post<void>(`/api/workspaces/${workspaceId}/search/log/${queryLogId}/click`, target)
}
