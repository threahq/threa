import { useQuery, useQueryClient } from "@tanstack/react-query"
import type { StreamBootstrap } from "@threahq/types"
import { contextBagApi, type StreamContextBagResponse } from "@/api"
import { streamKeys } from "./use-streams"

const EMPTY_RESPONSE: StreamContextBagResponse = { bag: null, refs: [] }

export const streamContextBagKey = (workspaceId: string, streamId: string) =>
  ["streamContextBag", workspaceId, streamId] as const

/**
 * Fetch the persisted ContextBag for a stream so the timeline message badge
 * + composer chip can render rich labels ("12 messages in #intro") without
 * re-fetching source threads. Synchronous render path:
 *
 * 1. The stream bootstrap (`GET /streams/:id/bootstrap`) folds the bag into
 *    its response. When that bootstrap query is in cache, this hook seeds
 *    its own cache from there via `initialData` — no fetch, no layout shift
 *    on first render of the timeline.
 * 2. If the bootstrap hasn't loaded yet (e.g. opening a stream cold from a
 *    deep link), the hook falls back to a direct `GET /context-bag` fetch.
 *    The query key is shared with the standalone composer flow so both
 *    surfaces get the same cached payload.
 *
 * Returns `{bag: null, refs: []}` for streams without an attached bag.
 */
export function useStreamContextBag(workspaceId: string, streamId: string | null | undefined) {
  const queryClient = useQueryClient()
  return useQuery({
    queryKey: streamId ? streamContextBagKey(workspaceId, streamId) : ["streamContextBag", workspaceId, "none"],
    queryFn: () => (streamId ? contextBagApi.getForStream(workspaceId, streamId) : Promise.resolve(EMPTY_RESPONSE)),
    enabled: Boolean(streamId),
    staleTime: 60_000,
    initialData: () => {
      if (!streamId) return undefined
      const bootstrap = queryClient.getQueryData<StreamBootstrap>(streamKeys.bootstrap(workspaceId, streamId))
      // The bootstrap payload's `contextBag` shape matches `StreamContextBagResponse`
      // exactly (both come from `fetchStreamBag` server-side). Cast through
      // the response type so the React Query cache is uniform.
      return bootstrap?.contextBag as StreamContextBagResponse | undefined
    },
    initialDataUpdatedAt: () => {
      if (!streamId) return undefined
      return queryClient.getQueryState(streamKeys.bootstrap(workspaceId, streamId))?.dataUpdatedAt
    },
  })
}
