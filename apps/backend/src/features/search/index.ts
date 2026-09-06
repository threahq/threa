export {
  createSearchHandlers,
  serializeSearchResult,
  serializeConversationSearchResult,
  serializeSearchCluster,
} from "./handlers"
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

export type {
  SearchResult,
  ResolvedFilters,
  GetAccessibleStreamsParams,
  ConversationSearchResult,
  ConversationForMessage,
} from "./repository"
export { buildSearchClusters, SEARCH_CLUSTER_MATCHES, type SearchCluster, type SearchClusterMatch } from "./clusters"
export type {
  SearchFilters,
  SearchParams,
  SearchClustersResponse,
  SearchPermissions,
  SearchServiceDependencies,
  MemoSearchLike,
  ArchiveStatus,
} from "./service"
