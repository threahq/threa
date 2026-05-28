import { useCallback } from "react"
import { useParams } from "react-router-dom"
import { useQueryClient } from "@tanstack/react-query"
import type { Memo } from "@threa/types"
import { searchMemos } from "@/api"
import { memoKeys } from "@/hooks/use-memos"
import { MemoSuggestionList } from "./memo-suggestion-list"
import { useSuggestion } from "./use-suggestion"

const MEMO_SEARCH_LIMIT = 8
/** Below this, searching is noise — wait for a more specific query. */
const MIN_QUERY_LENGTH = 2

/**
 * Manages the inline `/memo` search picker. Backs the suggestion list with the
 * same keyword + semantic memo search the memory explorer uses, fetched through
 * the shared query cache so repeated queries are instant and consistent.
 */
export function useMemoSuggestion() {
  const { workspaceId } = useParams<{ workspaceId: string }>()
  const queryClient = useQueryClient()

  const searchItems = useCallback(
    async (query: string): Promise<Memo[]> => {
      const trimmed = query.trim()
      if (!workspaceId || trimmed.length < MIN_QUERY_LENGTH) return []
      const request = { query: trimmed, limit: MEMO_SEARCH_LIMIT }
      const response = await queryClient.fetchQuery({
        queryKey: memoKeys.search(workspaceId, request),
        queryFn: () => searchMemos(workspaceId, request),
        staleTime: 30_000,
      })
      return response.results.map((result) => result.memo)
    },
    [workspaceId, queryClient]
  )

  const renderList = useCallback(
    (props: {
      ref: React.RefObject<{ onKeyDown: (event: KeyboardEvent) => boolean } | null>
      items: Memo[]
      clientRect: (() => DOMRect | null) | null
      command: (item: Memo) => void
    }) => (
      <MemoSuggestionList ref={props.ref} items={props.items} clientRect={props.clientRect} command={props.command} />
    ),
    []
  )

  const { suggestionConfig, renderSuggestionList, isActive } = useSuggestion<Memo>({
    extensionName: "memoSearch",
    searchItems,
    renderList,
  })

  return {
    suggestionConfig,
    renderMemoList: renderSuggestionList,
    isActive,
  }
}
