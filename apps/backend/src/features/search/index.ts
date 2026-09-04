export { createSearchHandlers, serializeSearchResult } from "./handlers"
export { resolveUserAccessibleStreamIds } from "./access"
export { SearchService, fuseRankedLists } from "./service"
export { SearchRepository } from "./repository"
export { hybridWeightsForQuery } from "./config"
export { SearchQueryExpander } from "./query-expansion"
export { StubQueryExpander } from "./query-expansion.stub"

export type { SearchResult, ResolvedFilters, GetAccessibleStreamsParams } from "./repository"
export type {
  SearchFilters,
  SearchParams,
  SearchPermissions,
  SearchServiceDependencies,
  ArchiveStatus,
} from "./service"
export type { QueryExpanderLike, QueryExpansionContext, QueryExpanderServiceConfig } from "./query-expansion"
