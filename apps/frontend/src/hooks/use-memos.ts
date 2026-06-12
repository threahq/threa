import { useQuery } from "@tanstack/react-query"
import { getMemo, searchMemos, type MemoSearchRequest } from "@/api"

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
