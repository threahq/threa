import { useCallback, useSyncExternalStore } from "react"
import { hashKey, useQueryClient } from "@tanstack/react-query"
import type { StreamBootstrap } from "@threahq/types"
import { streamKeys } from "./use-streams"

/**
 * A stream's bootstrap as cached, re-read whenever that cache entry changes,
 * without fetching it. Not a disabled `useQuery`: an observer's options become
 * the query's, so invalidating the bootstrap would refetch through its
 * cache-only `queryFn` instead of the stream view's real one.
 */
export function useCachedStreamBootstrap(
  workspaceId: string,
  streamId: string | null | undefined
): StreamBootstrap | undefined {
  const queryClient = useQueryClient()
  const key = streamKeys.bootstrap(workspaceId, streamId ?? "")
  const queryHash = hashKey(key)
  const subscribe = useCallback(
    (notify: () => void) =>
      queryClient.getQueryCache().subscribe((event) => {
        if (event?.query.queryHash === queryHash) notify()
      }),
    [queryClient, queryHash]
  )
  return useSyncExternalStore(subscribe, () => (streamId ? queryClient.getQueryData<StreamBootstrap>(key) : undefined))
}
