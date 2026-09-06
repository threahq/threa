import api from "./client"
import type { MemoExplorerResult } from "./memos"
import type { AuthorType, ConversationStatus, SearchClickKind, SearchClusterMatch, StreamType } from "@threahq/types"

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
  /** Plain-language refinements applied to the clustered list, oldest first. */
  refine?: string[]
}

/**
 * What happened to a requested refine: `applied` with the model's one-line
 * `note`, or not applied when the model call failed and the list is unrefined.
 */
export interface SearchRefineOutcome {
  applied: boolean
  note: string | null
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

/** The conversation a cluster row stands for; `firstMessageId` deep-links into the stream at its start. */
export interface SearchClusterConversation {
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
}

/**
 * One row of the search list: a conversation with the messages that matched
 * inside it, or a lone message with no conversation. A memo lands on the row
 * its source messages belong to, and a memo-only row carries those source
 * messages as its hits.
 */
export interface SearchCluster {
  conversation: SearchClusterConversation | null
  streamId: string
  matchedVia: SearchClusterMatch[]
  hits: SearchResultItem[]
  memoIds: string[]
  score: number
}

export interface SearchResponse {
  /** Message hits in ranked order, for the flat Ranked view. */
  results: SearchResultItem[]
  /** Conversation rows in ranked order; every hit in `results` sits in exactly one. */
  clusters: SearchCluster[]
  /** Memo hits referenced by `SearchCluster.memoIds`. Empty on exact and keyword-only searches. */
  memos: MemoExplorerResult[]
  /** Set only when the user opted into search query logging (`searchQueryLog` flag); pass it to `recordSearchClick`. */
  queryLogId: string | null
  /** Null when the request carried no refine. */
  refine: SearchRefineOutcome | null
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
    refine: request.refine,
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
