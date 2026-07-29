import { useInfiniteQuery, useQuery } from "@tanstack/react-query"
import { agentOutcomesApi, type AgentOutcomeFilters } from "@/api/agent-outcomes"

const PAGE_SIZE = 50

/**
 * What the derived "In this stream" panel actually reads: only follow-ups (its
 * delegations come from `useStreamDelegations`) and only this stream (every
 * other category in that panel is exact-stream, so a thread's follow-up would
 * render here with an anchor that resolves to nothing). Part of the query key —
 * a narrowed fetch under a wider key would serve the wide cache entry.
 */
const STREAM_PANEL_FILTERS = { kind: "follow_up", scope: "stream" } as const

export const agentOutcomeKeys = {
  all: ["agent-outcomes"] as const,
  workspace: (workspaceId: string, filters: AgentOutcomeFilters) =>
    [...agentOutcomeKeys.all, "workspace", workspaceId, filters] as const,
  /** The stream-scoped list behind the "In this stream" panel — the
   *  invalidation target when a follow-up or delegation event lands. */
  stream: (workspaceId: string, streamId: string) =>
    [...agentOutcomeKeys.all, "stream", workspaceId, streamId, STREAM_PANEL_FILTERS] as const,
}

/** Workspace-wide outcomes, keyset-paged newest `occursAt` first. */
export function useAgentOutcomes(
  workspaceId: string | undefined,
  filters: AgentOutcomeFilters,
  options: { enabled?: boolean } = {}
) {
  return useInfiniteQuery({
    queryKey: agentOutcomeKeys.workspace(workspaceId ?? "", filters),
    enabled: (options.enabled ?? true) && Boolean(workspaceId),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      agentOutcomesApi.list(workspaceId!, {
        ...filters,
        limit: filters.limit ?? PAGE_SIZE,
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    staleTime: 30_000,
  })
}

/**
 * One stream's outcomes (its threads included, server-side). Authoritative read
 * like `useStreamDelegations`: a follow-up's status lives in the row, and there
 * is no `fired`/`failed` event at all, so a window-derived view would freeze on
 * `pending` forever. stream-sync invalidates this key on the follow-up and
 * delegation socket events.
 */
export function useStreamAgentOutcomes(workspaceId: string, streamId: string, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: agentOutcomeKeys.stream(workspaceId, streamId),
    queryFn: () =>
      agentOutcomesApi.list(workspaceId, { streamIds: [streamId], ...STREAM_PANEL_FILTERS, limit: PAGE_SIZE }),
    enabled: (options.enabled ?? true) && !!workspaceId && !!streamId,
  })
}
