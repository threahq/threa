import { useCallback } from "react"
import { useParams } from "react-router-dom"
import { useQueryClient } from "@tanstack/react-query"
import type { Memo } from "@threa/types"
import { searchMemos } from "@/api"
import { memoKeys } from "@/hooks/use-memos"
import { MemoSuggestionList } from "./memo-suggestion-list"
import { useSuggestion } from "./use-suggestion"

const MEMO_SEARCH_LIMIT = 8

/**
 * Manages the inline `/memo` search picker. Backs the suggestion list with the
 * same keyword + semantic memo search the memory explorer uses, fetched through
 * the shared query cache so repeated queries are instant and consistent.
 *
 * `anchorStreamId` is the access anchor: the stream being composed in. Passing
 * it scopes results to what is shareable into that stream (the backend applies
 * the same access spec an agent invoked there would, resolving the thread root),
 * so a memo from an unrelated private stream can't be embedded into — and thereby
 * leaked to — this one.
 */
export function useMemoSuggestion(anchorStreamId?: string) {
  const { workspaceId } = useParams<{ workspaceId: string }>()
  const queryClient = useQueryClient()

  const searchItems = useCallback(
    async (query: string): Promise<Memo[]> => {
      if (!workspaceId) return []
      // An empty query is intentional: opening `/memo ` should immediately show
      // the first page of memos so they're discoverable before you know what to
      // search for. The backend orders an empty search by recency; typing a
      // query switches it to keyword + semantic ranking.
      const trimmed = query.trim()
      const request = { query: trimmed, limit: MEMO_SEARCH_LIMIT, anchorStreamId }
      const response = await queryClient.fetchQuery({
        queryKey: memoKeys.search(workspaceId, request),
        queryFn: () => searchMemos(workspaceId, request),
        staleTime: 30_000,
      })
      return response.results.map((result) => result.memo)
    },
    [workspaceId, queryClient, anchorStreamId]
  )

  const renderList = useCallback(
    (props: {
      ref: React.RefObject<{ onKeyDown: (event: KeyboardEvent) => boolean } | null>
      items: Memo[]
      query: string
      clientRect: (() => DOMRect | null) | null
      command: (item: Memo) => void
    }) => (
      <MemoSuggestionList
        ref={props.ref}
        items={props.items}
        clientRect={props.clientRect}
        command={props.command}
        emptyState="No memos found"
      />
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
