import { useQuery } from "@tanstack/react-query"
import { giphyApi } from "@/api"

export const giphyKeys = {
  config: (workspaceId: string) => ["giphy", "config", workspaceId] as const,
}

/**
 * Whether the `/giphy` picker is available in this workspace. The backend
 * reports this from whether a Giphy API key is configured; it effectively never
 * changes within a deploy, so cache it indefinitely.
 */
export function useGiphyEnabled(workspaceId: string | undefined): boolean {
  const { data } = useQuery({
    queryKey: giphyKeys.config(workspaceId ?? ""),
    queryFn: ({ signal }) => giphyApi.getConfig(workspaceId!, { signal }),
    enabled: !!workspaceId,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  })
  return data?.enabled ?? false
}
