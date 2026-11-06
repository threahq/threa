import { useQuery } from "@tanstack/react-query"
import { docKeys, docsApi } from "@/api/docs"

/** The viewer's readable docs, live or archived, with their editors; refetched on every mount so the list page opens current. */
export function useDocList(workspaceId: string, { archived }: { archived: boolean }) {
  return useQuery({
    queryKey: archived ? docKeys.archivedList(workspaceId) : docKeys.list(workspaceId),
    queryFn: () => docsApi.list(workspaceId, { archived }),
    staleTime: 30_000,
    refetchOnMount: "always",
  })
}
