export { createSearchHandlers, serializeSearchResult, serializeConversationSearchResult } from "./handlers"
export { resolveUserAccessibleStreamIds } from "./access"
export { SearchService } from "./service"
export { SearchRepository } from "./repository"
export { hybridWeightsForQuery, CONVERSATION_SEARCH_LIMIT, CONVERSATION_SEARCH_MAX_DISTANCE } from "./config"
export { SearchQueryExpander } from "./query-expansion"
export { StubQueryExpander } from "./query-expansion.stub"

export type { SearchResult, ConversationSearchResult, ResolvedFilters, GetAccessibleStreamsParams } from "./repository"
export type {
  SearchFilters,
  SearchParams,
  SearchPermissions,
  SearchServiceDependencies,
  SearchResponse,
  ArchiveStatus,
} from "./service"
