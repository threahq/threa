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
  /** Resolves when the page has landed and been seeded (the query fn seeds
   *  before it resolves) — a date jump pages in a loop and must not re-read IDB
   *  before the rows are there. Its `hasNextPage` is the post-fetch truth; the
   *  field above is a render-time snapshot and stays stale inside such a loop. */
  fetchNextPage: () => Promise<{ hasNextPage: boolean }>
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
    // Seeding here, not in an effect, is what makes "the page is in IDB by the
    // time the fetch resolves" structural: `fetchNextPage` awaits this, so the
    // date jump's paging loop can read IDB straight after. Once per page, too —
    // the effect this replaces re-put every accumulated page on every change,
    // costing O(pages²) writes, each waking the live query the panel renders
    // from. A reconnect refetch re-runs this per page, so INV-53 catch-up still
    // rewrites the whole window.
    queryFn: async ({ pageParam }) => {
      const request: ListStreamContextRequest = { scope, category, q, from, before, after, cursor: pageParam }
      const page = await streamContextApi.list(workspaceId, streamId, request)
      await seedStreamContextItems(workspaceId, rootStreamId, page.items)
      return page
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    staleTime: Infinity,
    refetchOnMount: true,
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
    enabled: enabled && !!workspaceId && !!streamId,
  })

  const firstPage = query.data?.pages[0]
  return {
    counts: firstPage?.counts ?? null,
    mode: firstPage?.mode ?? null,
    hasNextPage: query.hasNextPage,
    fetchNextPage: async () => ({ hasNextPage: (await query.fetchNextPage()).hasNextPage }),
    isFetchingNextPage: query.isFetchingNextPage,
    isLoading: query.isLoading,
    isError: query.isError,
  }
}
