import { useQuery } from "@tanstack/react-query"
import { docKeys, docsApi } from "@/api/docs"

/** The viewer's readable docs with their editors; refetched on every mount so the list page opens current. */
export function useDocList(workspaceId: string) {
  return useQuery({
    queryKey: docKeys.list(workspaceId),
    queryFn: () => docsApi.list(workspaceId),
    staleTime: 30_000,
    refetchOnMount: "always",
  })
}
