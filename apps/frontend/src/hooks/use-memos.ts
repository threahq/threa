import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  archiveMemo,
  deleteMemo,
  getMemo,
  searchMemos,
  unarchiveMemo,
  updateMemo,
  type MemoDetailResponse,
  type MemoSearchRequest,
  type MemoSearchResponse,
  type MemoUpdateRequest,
} from "@/api"

export const memoKeys = {
  all: ["memos"] as const,
  /** Prefix for every search query in one workspace — the invalidation target
   *  when a `memo:created` event lands (workspace-sync). */
  searches: (workspaceId: string) => [...memoKeys.all, "search", workspaceId] as const,
  search: (workspaceId: string, request: MemoSearchRequest) => [...memoKeys.searches(workspaceId), request] as const,
  detail: (workspaceId: string, memoId: string) => [...memoKeys.all, "detail", workspaceId, memoId] as const,
}

export function useMemoSearch(workspaceId: string, request: MemoSearchRequest) {
  return useQuery({
    queryKey: memoKeys.search(workspaceId, request),
    queryFn: () => searchMemos(workspaceId, request),
    enabled: !!workspaceId,
  })
}

export function useMemoDetail(workspaceId: string, memoId: string | null) {
  return useQuery({
    queryKey: memoKeys.detail(workspaceId, memoId ?? ""),
    queryFn: () => getMemo(workspaceId, memoId!),
    enabled: !!workspaceId && !!memoId,
  })
}

/**
 * Seed the memo's detail cache with the mutation's response and invalidate the
 * search lists so the row reflects the edit/archive/restore (a search list
 * scoped to `status: ['active']` drops an archived memo; an `archived` list
 * gains it). Shared by all three memo mutations.
 */
function useMemoMutationSettled(workspaceId: string) {
  const queryClient = useQueryClient()
  return (response: MemoDetailResponse) => {
    queryClient.setQueryData(memoKeys.detail(workspaceId, response.memo.memo.id), response)
    void queryClient.invalidateQueries({ queryKey: memoKeys.searches(workspaceId) })
  }
}

export function useUpdateMemo(workspaceId: string) {
  const onSuccess = useMemoMutationSettled(workspaceId)
  return useMutation({
    mutationFn: ({ memoId, update }: { memoId: string; update: MemoUpdateRequest }) =>
      updateMemo(workspaceId, memoId, update),
    onSuccess,
  })
}

export function useArchiveMemo(workspaceId: string) {
  const onSuccess = useMemoMutationSettled(workspaceId)
  return useMutation({
    mutationFn: (memoId: string) => archiveMemo(workspaceId, memoId),
    onSuccess,
  })
}

export function useUnarchiveMemo(workspaceId: string) {
  const onSuccess = useMemoMutationSettled(workspaceId)
  return useMutation({
    mutationFn: (memoId: string) => unarchiveMemo(workspaceId, memoId),
    onSuccess,
  })
}

/**
 * Hard-delete a user-scoped memo (roadmap 6.4). Unlike the other mutations there
 * is no detail response to seed — the row is gone — so drop its detail cache and
 * invalidate the search lists to remove it from view.
 */
export function useDeleteMemo(workspaceId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (memoId: string) => deleteMemo(workspaceId, memoId),
    onSuccess: (_result, memoId) => {
      queryClient.removeQueries({ queryKey: memoKeys.detail(workspaceId, memoId) })
      // Drop the deleted memo from cached search lists synchronously so the
      // explorer never re-selects a now-gone id off a stale list (a 404 refetch +
      // skeleton flash) before the invalidated search refetch lands.
      queryClient.setQueriesData<MemoSearchResponse>({ queryKey: memoKeys.searches(workspaceId) }, (old) =>
        old ? { ...old, results: old.results.filter((r) => r.memo.id !== memoId) } : old
      )
      void queryClient.invalidateQueries({ queryKey: memoKeys.searches(workspaceId) })
    },
  })
}
