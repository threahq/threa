import { useEffect, useMemo, useRef } from "react"
import { useSearch } from "@/hooks"
import { useWorkspaceStreams, useWorkspaceUsers } from "@/stores/workspace-store"
import { parseSearchQuery, type ParsedFilter } from "@/lib/search-query-parser"
import type { SearchFilters, SearchResultItem } from "@/api"
import type { ArchiveStatus } from "@/api"
import type { StreamType } from "@threa/types"

export const SEARCH_DEBOUNCE_MS = 300
const SEARCH_RESULT_LIMIT = 50

export interface MessageSearchState {
  results: SearchResultItem[]
  isLoading: boolean
  error: Error | null
  /** Structured filters parsed out of the query string (from:@…, in:#…, …). */
  parsedFilters: ParsedFilter[]
  /** Free-text part of the query with filters removed. */
  searchText: string
  /** True when the query contains anything searchable. */
  hasQuery: boolean
}

/**
 * Debounced workspace message search over a raw query string with inline
 * filter syntax (`from:@user in:#channel after:2026-01-01 …`). Shared by the
 * desktop sidebar search panel and the mobile search page so both surfaces
 * parse, resolve, and rank identically.
 */
export function useMessageSearch(workspaceId: string, query: string): MessageSearchState {
  const users = useWorkspaceUsers(workspaceId)
  const streams = useWorkspaceStreams(workspaceId)
  const { results, isLoading, error, search, clear } = useSearch({ workspaceId, limit: SEARCH_RESULT_LIMIT })

  const { filters: parsedFilters, text: searchText } = useMemo(() => parseSearchQuery(query), [query])

  // Resolve filter slugs (user/stream handles) to ids the API understands.
  const apiFilters = useMemo((): SearchFilters => {
    const filters: SearchFilters = {}

    const resolveUserSlug = (slug: string) => users.find((u) => u.slug === slug)?.id ?? null
    const resolveStreamSlug = (slug: string) => streams.find((s) => s.slug === slug)?.id ?? null

    for (const filter of parsedFilters) {
      switch (filter.type) {
        case "from": {
          const userId = resolveUserSlug(filter.value)
          if (userId) filters.from = userId
          break
        }
        case "with": {
          const userId = resolveUserSlug(filter.value)
          if (userId) filters.with = [...(filters.with ?? []), userId]
          break
        }
        case "type":
          filters.type = [...(filters.type ?? []), filter.value as StreamType]
          break
        case "status":
          filters.status = [...(filters.status ?? []), filter.value as ArchiveStatus]
          break
        case "in": {
          // in:#channel resolves a stream slug; in:@user resolves the user id
          // (the backend maps it to the DM stream with that user)
          const id = filter.raw.startsWith("in:#") ? resolveStreamSlug(filter.value) : resolveUserSlug(filter.value)
          if (id) filters.in = [...(filters.in ?? []), id]
          break
        }
        case "after":
          filters.after = filter.value
          break
        case "before":
          filters.before = filter.value
          break
      }
    }

    return filters
  }, [parsedFilters, users, streams])

  const hasQuery = searchText.trim().length > 0 || parsedFilters.length > 0

  // `users`/`streams` come from live queries that produce a NEW array on every
  // workspace IndexedDB write (incoming messages, presence, …), which gives
  // `apiFilters` a new identity even when its VALUES are unchanged. Depending
  // on the object would reset the debounce on every socket event and starve
  // the search in an active workspace — so the effect keys on a serialized
  // form and reads the current object through a ref.
  const filtersKey = JSON.stringify(apiFilters)
  const filtersRef = useRef(apiFilters)
  filtersRef.current = apiFilters

  useEffect(() => {
    if (!hasQuery) {
      clear()
      return
    }

    const timer = setTimeout(() => {
      void search(searchText, filtersRef.current)
    }, SEARCH_DEBOUNCE_MS)

    return () => clearTimeout(timer)
  }, [hasQuery, searchText, filtersKey, search, clear])

  return { results, isLoading, error, parsedFilters, searchText, hasQuery }
}
