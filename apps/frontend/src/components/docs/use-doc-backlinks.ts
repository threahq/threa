import { useQuery } from "@tanstack/react-query"
import type { DocBacklink } from "@threahq/types"
import { docKeys, docsApi } from "@/api/docs"

const NO_BACKLINKS: DocBacklink[] = []

/** Readable docs linking to this one, newest first; empty while loading or when the load fails. */
export function useDocBacklinks(workspaceId: string, docId: string): DocBacklink[] {
  const { data } = useQuery({
    queryKey: docKeys.backlinks(workspaceId, docId),
    queryFn: () => docsApi.listBacklinks(workspaceId, docId),
    staleTime: 30_000,
    refetchOnMount: "always",
  })
  return data?.backlinks ?? NO_BACKLINKS
}
