export { createSearchHandlers, serializeSearchResult, serializeConversationForMessage } from "./handlers"
export { resolveUserAccessibleStreamIds } from "./access"
export { SearchService } from "./service"
export { SearchQueryLogService, type RecordSearchQueryInput } from "./query-log-service"
export {
  SearchQueryLogRepository,
  type SearchQueryLogRow,
  type SearchQueryMode,
  type SearchQueryLogResultIds,
} from "./query-log-repository"
export { SearchRepository } from "./repository"
export { hybridWeightsForQuery, searchRankingForFlag, SEARCH_RRF_K, type SearchRanking } from "./config"
export { SearchQueryExpander } from "./query-expansion"
export { StubQueryExpander } from "./query-expansion.stub"
export { SearchRefiner } from "./refine"
export { StubSearchRefiner } from "./refine.stub"

export type { SearchResult, ResolvedFilters, GetAccessibleStreamsParams } from "./repository"
export type {
  SearchFilters,
  SearchParams,
  SearchPermissions,
  SearchServiceDependencies,
  ArchiveStatus,
} from "./service"
