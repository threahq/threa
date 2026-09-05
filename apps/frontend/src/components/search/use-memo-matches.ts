import { useEffect, useState } from "react"
import { useMemoSearch } from "@/hooks"
import type { MemoExplorerResult, SearchFilters } from "@/api"
import type { FilterType, ParsedFilter } from "@/lib/search-query-parser"
import { SEARCH_DEBOUNCE_MS } from "./use-message-search"

// Memo search understands only in/before/after; a memo match next to a
// from:/with:/type:/status: filter would silently ignore that filter.
const FILTERS_WITHOUT_MEMO_EQUIVALENT: FilterType[] = ["from", "with", "type", "status"]

interface UseMemoMatchesParams {
  searchText: string
  parsedFilters: ParsedFilter[]
  apiFilters: SearchFilters
  hasQuery: boolean
}

interface MemoMatchesState {
  memos: MemoExplorerResult[]
  exploreHref: string
}

// Takes the full `searchText` rather than `semanticText`: memo search has no
// phrase handling, and a phrase-only query would otherwise collapse to "".
export function useMemoMatches(workspaceId: string, params: UseMemoMatchesParams): MemoMatchesState {
  const { searchText, parsedFilters, apiFilters, hasQuery } = params

  const [debouncedText, setDebouncedText] = useState(searchText)
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedText(searchText), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [searchText])

  const enabled =
    hasQuery &&
    debouncedText.trim().length > 0 &&
    !parsedFilters.some((filter) => FILTERS_WITHOUT_MEMO_EQUIVALENT.includes(filter.type))

  const { data } = useMemoSearch(
    workspaceId,
    {
      query: debouncedText,
      limit: 3,
      filters: { in: apiFilters.in, before: apiFilters.before, after: apiFilters.after },
    },
    { enabled }
  )

  return {
    memos: enabled ? (data?.results ?? []) : [],
    exploreHref: `/w/${workspaceId}/memory?q=${encodeURIComponent(debouncedText)}`,
  }
}
