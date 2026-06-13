import { useState, useCallback, useRef } from "react"
import { searchMessages, type SearchFilters, type SearchResultItem } from "@/api"

interface UseSearchOptions {
  workspaceId: string
  /** Max results per request (backend default is 20, max 100). */
  limit?: number
}

interface UseSearchReturn {
  results: SearchResultItem[]
  isLoading: boolean
  error: Error | null
  search: (query: string, filters?: SearchFilters) => Promise<void>
  clear: () => void
}

export function useSearch({ workspaceId, limit }: UseSearchOptions): UseSearchReturn {
  const [results, setResults] = useState<SearchResultItem[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  // Monotonic request counter so a slow earlier response can't clobber the
  // results of a later query (searches race as the user types).
  const requestIdRef = useRef(0)

  const search = useCallback(
    async (query: string, filters?: SearchFilters) => {
      const requestId = ++requestIdRef.current
      setIsLoading(true)
      setError(null)

      try {
        const response = await searchMessages(workspaceId, { query, filters, limit })
        if (requestId !== requestIdRef.current) return
        setResults(response.results)
      } catch (e) {
        if (requestId !== requestIdRef.current) return
        setError(e instanceof Error ? e : new Error("Search failed"))
        setResults([])
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
    setError(null)
    setIsLoading(false)
  }, [])

  return { results, isLoading, error, search, clear }
}
