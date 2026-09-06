import { useState, useCallback, useRef } from "react"
import {
  searchMessages,
  type MemoExplorerResult,
  type SearchCluster,
  type SearchFilters,
  type SearchResultItem,
  type SearchSteerOutcome,
} from "@/api"

interface UseSearchOptions {
  workspaceId: string
  /** Max results per request (backend default is 20, max 100). */
  limit?: number
}

interface UseSearchReturn {
  results: SearchResultItem[]
  clusters: SearchCluster[]
  memos: MemoExplorerResult[]
  /** Non-null only when the backend logged this search (opt-in `searchQueryLog` flag). */
  queryLogId: string | null
  /** Outcome of the last request's steer; null when it carried none. */
  steer: SearchSteerOutcome | null
  isLoading: boolean
  error: Error | null
  search: (query: string, filters?: SearchFilters, phrases?: string[], steer?: string[]) => Promise<void>
  clear: () => void
}

export function useSearch({ workspaceId, limit }: UseSearchOptions): UseSearchReturn {
  const [results, setResults] = useState<SearchResultItem[]>([])
  const [clusters, setClusters] = useState<SearchCluster[]>([])
  const [memos, setMemos] = useState<MemoExplorerResult[]>([])
  const [queryLogId, setQueryLogId] = useState<string | null>(null)
  const [steer, setSteer] = useState<SearchSteerOutcome | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  // Monotonic request counter so a slow earlier response can't clobber the
  // results of a later query (searches race as the user types).
  const requestIdRef = useRef(0)

  const search = useCallback(
    async (query: string, filters?: SearchFilters, phrases?: string[], steer?: string[]) => {
      const requestId = ++requestIdRef.current
      setIsLoading(true)
      setError(null)

      try {
        const response = await searchMessages(workspaceId, { query, filters, phrases, steer, limit })
        if (requestId !== requestIdRef.current) return
        setResults(response.results)
        setClusters(response.clusters)
        setMemos(response.memos)
        setQueryLogId(response.queryLogId)
        setSteer(response.steer)
      } catch (e) {
        if (requestId !== requestIdRef.current) return
        setError(e instanceof Error ? e : new Error("Search failed"))
        setResults([])
        setClusters([])
        setMemos([])
        setQueryLogId(null)
        setSteer(null)
      } finally {
        if (requestId === requestIdRef.current) {
          setIsLoading(false)
        }
      }
    },
    [workspaceId, limit]
  )

  const clear = useCallback(() => {
    // Invalidate any in-flight request so it can't repopulate after the clear
    requestIdRef.current++
    setResults([])
    setClusters([])
    setMemos([])
    setQueryLogId(null)
    setSteer(null)
    setError(null)
    setIsLoading(false)
  }, [])

  return { results, clusters, memos, queryLogId, steer, isLoading, error, search, clear }
}
