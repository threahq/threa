import { useEffect } from "react"
import { useInfiniteQuery } from "@tanstack/react-query"
import { streamContextApi, type ListStreamContextRequest } from "@/api"
import { seedStreamContextItems } from "@/stores/stream-context-store"
import type { ContextCategory, ListStreamContextResponse, StreamContextScope } from "@threa/types"

export const streamContextKeys = {
  all: ["stream-context"] as const,
  feed: (workspaceId: string, streamId: string, params: Record<string, string | undefined>) =>
    ["stream-context", workspaceId, streamId, params] as const,
}

export interface UseStreamContextFeedOptions {
  scope?: StreamContextScope
  category?: ContextCategory
  /** Free text; already debounced by the caller. */
  q?: string
  /** Author **id** (the panel resolves `from:@slug` before calling). */
  from?: string
  before?: string
  after?: string
  enabled?: boolean
}

export interface StreamContextFeed {
  counts: ListStreamContextResponse["counts"]
  /** `client` = sealed stream; the panel derives locally instead. */
  mode: ListStreamContextResponse["mode"] | null
  hasNextPage: boolean
  fetchNextPage: () => void
  isFetchingNextPage: boolean
  isLoading: boolean
  isError: boolean
}

/**
 * The "In this stream" panel's FETCH/SEED engine, not its read authority: every
 * fetched page is written into the `streamContextItems` IDB store
 * (subscribe-then-fetch, INV-53), and the panel renders reactively from IDB via
 * `useStreamContextRows` — the same rails the board rides. Live sync appliers and
 * locally derived rows re-sort the feed in place without a refetch; this query
 * just keeps the head fresh on open and pages older rows in.
 * `refetchOnReconnect` is the catch-up backstop after an offline window.
 *
 * `counts` and `mode` are whole-scope facts and ride on the first page only.
 */
export function useStreamContextFeed(
  workspaceId: string,
  streamId: string,
  rootStreamId: string,
  options: UseStreamContextFeedOptions = {}
): StreamContextFeed {
  const { scope = "tree", category, q, from, before, after, enabled = true } = options

  const query = useInfiniteQuery({
    queryKey: streamContextKeys.feed(workspaceId, streamId, { scope, category, q, from, before, after }),
    queryFn: ({ pageParam }) => {
      const request: ListStreamContextRequest = { scope, category, q, from, before, after, cursor: pageParam }
      return streamContextApi.list(workspaceId, streamId, request)
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    staleTime: Infinity,
    refetchOnMount: true,
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
    enabled: enabled && !!workspaceId && !!streamId,
  })

  const { data } = query
  useEffect(() => {
    if (!data) return
    void seedStreamContextItems(
      workspaceId,
      rootStreamId,
      data.pages.flatMap((page) => page.items)
    )
  }, [data, workspaceId, rootStreamId])

  const firstPage = data?.pages[0]
  return {
    counts: firstPage?.counts ?? null,
    mode: firstPage?.mode ?? null,
    hasNextPage: query.hasNextPage,
    fetchNextPage: () => void query.fetchNextPage(),
    isFetchingNextPage: query.isFetchingNextPage,
    isLoading: query.isLoading,
    isError: query.isError,
  }
}
