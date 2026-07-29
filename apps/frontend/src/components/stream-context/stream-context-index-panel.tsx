import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import type { StreamBootstrap, StreamMember } from "@threa/types"
import type { VirtualizerHandle } from "virtua"
import { ChevronDown, ChevronRight, Search, WifiOff, X } from "lucide-react"
import { streamContextApi } from "@/api"
import { useIsOnline } from "@/components/layout/connection-status"
import { extractSearchTerms } from "@/components/search/highlight"
import { SearchFilterChips } from "@/components/search/search-filter-chips"
import { SearchFilterMenu } from "@/components/search/search-filter-menu"
import { SEARCH_DEBOUNCE_MS } from "@/components/search/use-message-search"
import { Input } from "@/components/ui/input"
import { useFormattedDate } from "@/hooks"
import { useCurrentWorkspaceUserId } from "@/hooks/use-current-workspace-user-id"
import { useStreamName } from "@/hooks/use-stream-name"
import { streamKeys } from "@/hooks/use-streams"
import { parseSearchQuery, type ParsedFilter } from "@/lib/search-query-parser"
import { contextItemFromCached } from "@/lib/stream-context/from-cached"
import { collapseContextRows, countByCategory, filterContextRows } from "@/lib/stream-context/filter"
import type { ContextCategory, ContextItem } from "@/lib/stream-context/types"
import { localStartOfDayMs } from "@/lib/dates"
import { markerIndexForDate, oldestItemIndex } from "@/lib/stream-context/grouping"
import { cn } from "@/lib/utils"
import {
  contextGroupRef,
  seedStreamContextItems,
  useStreamContextOccurrences,
  readStreamContextRows,
  useStreamContextRows,
  type CachedStreamContextItem,
} from "@/stores/stream-context-store"
import { useStreamFromStore } from "@/stores/stream-store"
import { useWorkspaceUsers } from "@/stores/workspace-store"
import { StreamContextRow } from "./stream-context-row"
import { useStreamContextFeed } from "./use-stream-context-feed"
import {
  chipsFromCounts,
  ContextChipRow,
  ContextEmpty,
  ContextPanelHeader,
  ContextSkeleton,
  ContextTimeline,
  useContextFilter,
  type Filter,
  type StreamContextPanelProps,
} from "./stream-context-chrome"
import { StreamContextDerivedPanel } from "./stream-context-derived-panel"

/**
 * `in:`/`type:`/`status:`/`with:` are meaningless in a single stream's context
 * feed, so the panel neither offers them in the menu nor forwards a typed one to
 * the endpoint — it surfaces them as unsupported instead of silently ignoring
 * them (INV-11).
 */
const SUPPORTED_FILTERS = ["from", "before", "after"] as const
type SupportedFilter = (typeof SUPPORTED_FILTERS)[number]

function isSupported(filter: ParsedFilter): filter is ParsedFilter & { type: SupportedFilter } {
  return (SUPPORTED_FILTERS as readonly string[]).includes(filter.type)
}

/** Sentinel prefetch margin — matches the attachment explorer's list. */
const NEXT_PAGE_PREFETCH_MARGIN = "300px"

/**
 * The indexed "In this stream" panel: rows come from IDB (`useStreamContextRows`),
 * kept fresh by the live sync appliers and widened by
 * {@link useStreamContextFeed}'s paged seeds. Sealed streams get `mode: "client"`
 * back from the endpoint and fall through to the derive path.
 */
const DAY_MS = 24 * 60 * 60 * 1000
// A jump into unloaded history pages until it reaches the day. Bounded so a date
// older than the whole stream settles instead of paging forever; at 40 rows a
// page this reaches ~400 artifacts back, and the user can keep scrolling.
const MAX_JUMP_PAGES = 10

export function StreamContextIndexPanel(props: StreamContextPanelProps) {
  const { workspaceId, streamId, onClose, onJumpToMessage, onOpenThread, onOpenMemo, onOpenGallery } = props
  const stream = useStreamFromStore(streamId)
  const rootStreamId = stream?.rootStreamId ?? streamId
  const rootStream = useStreamFromStore(rootStreamId)
  const isOnline = useIsOnline()
  const users = useWorkspaceUsers(workspaceId)

  const [filter, setFilter] = useContextFilter()
  const [query, setQuery] = useState("")
  const [debouncedQuery, setDebouncedQuery] = useState("")
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [query])

  // Phase 1 reads the LIVE query so the cached window narrows on the keystroke;
  // only phase 2 (the endpoint) waits out the debounce.
  const live = useSearchState(query, users)
  const debounced = useSearchState(debouncedQuery, users)
  const unsupported = live.parsed.filters.filter((f) => !isSupported(f))

  // Counts are whole-scope and CATEGORY-INDEPENDENT server-side (`service.list`
  // strips the category before counting), but they ride the feed's first page,
  // and that query is keyed on the category. Selecting a chip therefore starts a
  // fresh query with no counts yet, so anything reading `feed.counts` directly
  // would drop to the local tally — hundreds → tens → hundreds as the page lands.
  // Hold the last server counts and keep using them while the category changes;
  // key them by the filters that DO narrow them so a new search can't show stale
  // numbers.
  const countsKey = [
    streamId,
    debounced.parsed.text ?? "",
    debounced.authorId ?? "",
    debounced.before ?? "",
    debounced.after ?? "",
  ].join("|")
  const [heldCounts, setHeldCounts] = useState<{ key: string; counts: Record<ContextCategory, number> } | null>(null)
  const serverCounts = heldCounts?.key === countsKey ? heldCounts.counts : null

  // A `?context=<category>` deep link (or a chip whose category later empties
  // out) must not strand the panel on a filter the scope has nothing for — fall
  // back to "all" once the server-owned counts say so, for the query and the
  // chip row alike.
  const effectiveFilter: Filter = filter !== "all" && serverCounts?.[filter] === 0 ? "all" : filter

  const category: ContextCategory | undefined = effectiveFilter === "all" ? undefined : effectiveFilter
  const feed = useStreamContextFeed(workspaceId, streamId, rootStreamId, {
    scope: "tree",
    category,
    q: debounced.parsed.text || undefined,
    from: debounced.authorId ?? undefined,
    before: debounced.before,
    after: debounced.after,
  })
  const { authorId, before, after, searchTerms, supported } = live

  const rows = useStreamContextRows(workspaceId, streamId, rootStreamId, "tree")

  // Who `from:` can meaningfully name here: this stream's members, plus the
  // viewer (a public root grants read without a membership row — INV-62 — so
  // "things I shared" must stay reachable). A workspace-wide picker offers
  // people this stream can hold nothing from — in a DM, everyone except the two
  // participants — and every such choice is a filter that returns nothing.
  //
  // Threads inherit membership from their root (INV-62), so the root's roster is
  // the answer for a thread too. `undefined` while no roster is cached: unscoped
  // is honest about not knowing, where a roster of one would not be.
  const currentUserId = useCurrentWorkspaceUserId(workspaceId)
  const members = useCachedStreamMembers(workspaceId, rootStreamId, streamId)
  const authorIds = useMemo(() => {
    if (!members) return undefined
    const ids = new Set(members.map((member) => member.memberId))
    if (currentUserId) ids.add(currentUserId)
    return ids
  }, [members, currentUserId])

  // Phase 1 — narrow the cached window locally and render before the endpoint
  // answers. The server phase widens the same set through IDB, so there is no
  // second list to reconcile.
  const visibleRows = useMemo(
    () =>
      collapseContextRows(
        filterContextRows(rows ?? [], {
          category,
          terms: searchTerms,
          authorId: authorId ?? undefined,
          before,
          after,
        })
      ),
    [rows, category, searchTerms, authorId, before, after]
  )
  // Counts are whole-scope facts the server owns; the local tally is the
  // offline/first-paint fallback: computed over the same search/author/date
  // narrowing as the list but never the category, so every chip stays reachable
  // — collapsed, so a repeatedly shared link counts once, as it does server-side.
  const localCounts = useMemo(
    () =>
      countByCategory(
        collapseContextRows(
          filterContextRows(rows ?? [], { terms: searchTerms, authorId: authorId ?? undefined, before, after })
        )
      ),
    [rows, searchTerms, authorId, before, after]
  )
  const counts = feed.counts ?? serverCounts ?? localCounts
  const feedCounts = feed.counts
  useEffect(() => {
    if (feedCounts) setHeldCounts({ key: countsKey, counts: feedCounts })
  }, [feedCounts, countsKey])
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0)

  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const listRef = useRef<VirtualizerHandle | null>(null)
  const sentinelRef = useRef<HTMLDivElement | null>(null)

  // Jump the LIST to a date — navigation, not filtering: the feed stays one
  // continuous list and the view moves. The target is usually not mounted,
  // hence virtua's `scrollToIndex` over a DOM scroll.
  // The chip, the search box and the counts repaint on the tap; the list itself
  // is allowed to arrive a frame later. Rebuilding and re-rendering a long list
  // is the one part of this panel that can't be made free, so it yields instead
  // of blocking the input that asked for it. Everything the list needs hangs off
  // this one deferred value — the rows, their keys, and the jump's index into
  // them — so nothing can index a list the user isn't looking at.
  const renderedRows = useDeferredValue(visibleRows)
  const items = useMemo(
    () => renderedRows.map(contextItemFromCached).filter((item): item is ContextItem => item !== null),
    [renderedRows]
  )

  // Which jump is paging, not merely whether one is: an abandoned run must not
  // clear a skeleton the run that replaced it is still showing, and must not
  // leave its own showing forever when it bails.
  const [pagingFor, setPagingFor] = useState<number | null>(null)
  const jumping = pagingFor !== null
  const finishPaging = useCallback((generation: number) => {
    setPagingFor((current) => (current === generation ? null : current))
  }, [])
  // A jump can take ten round trips, and everything it decides with — the date,
  // the filters it re-filters each page against — is captured when it starts.
  // Anything that supersedes it (a second jump, a changed chip or query) bumps
  // this, and the older run stops instead of scrolling the list somewhere the
  // user has since navigated away from.
  const jumpGeneration = useRef(0)
  useEffect(() => {
    jumpGeneration.current += 1
  }, [category, searchTerms, authorId, before, after])
  const jumpToDate = useCallback(
    async (date: Date) => {
      const generation = (jumpGeneration.current += 1)
      const endOfDayMs = localStartOfDayMs(date) + DAY_MS
      const now = new Date()
      let candidates = items
      let index = markerIndexForDate(candidates, endOfDayMs, now)
      // Paging to an unloaded date is several round trips; without this the
      // panel just sits there. Only set it when a fetch is actually needed, so
      // the common in-window jump stays instant and flicker-free.
      if (index === -1 && feed.hasNextPage) setPagingFor(generation)
      // Not loaded that far back yet: page until it is, bounded so a date older
      // than the whole stream can't spin. Each page widens the IDB-backed list.
      // `more` tracks the FETCH's own result — `feed.hasNextPage` is captured at
      // render and stays true here, so it would keep re-reading IDB for every
      // remaining iteration after history runs out.
      let more = feed.hasNextPage
      for (let page = 0; index === -1 && page < MAX_JUMP_PAGES && more; page += 1) {
        more = (await feed.fetchNextPage()).hasNextPage
        const fresh = await readStreamContextRows(workspaceId, streamId, rootStreamId, "tree")
        const rebuilt = collapseContextRows(
          filterContextRows(fresh, {
            category,
            terms: searchTerms,
            authorId: authorId ?? undefined,
            before,
            after,
          })
        )
        candidates = rebuilt.map(contextItemFromCached).filter((item): item is ContextItem => item !== null)
        index = markerIndexForDate(candidates, endOfDayMs, now)
        if (jumpGeneration.current !== generation) return finishPaging(generation)
      }
      if (jumpGeneration.current !== generation) return finishPaging(generation)
      finishPaging(generation)
      // Past the start of history — either the stream's, or as far as the page
      // bound reached. Travel to the oldest thing there is: asking for a year
      // ago means "as far back as you can go", not "refuse unless you find that
      // exact day". Only a genuinely empty list has nowhere to go, and its
      // empty state already says so.
      if (index === -1) index = oldestItemIndex(candidates, now)
      if (index === -1) return
      listRef.current?.scrollToIndex(index, { align: "start" })
      // The marker that opened the menu is usually windowed out by the jump, so
      // Radix's focus-return lands on a removed node and focus falls to <body>.
      // Park it on the scroller instead: the user stays inside the panel and can
      // keep tabbing from where they landed.
      scrollerRef.current?.focus({ preventScroll: true })
    },
    [items, feed, workspaceId, streamId, rootStreamId, category, searchTerms, authorId, before, after]
  )
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = feed
  useEffect(() => {
    const node = sentinelRef.current
    if (!node) return
    if (!hasNextPage || isFetchingNextPage) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) fetchNextPage()
      },
      { rootMargin: NEXT_PAGE_PREFETCH_MARGIN }
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [hasNextPage, isFetchingNextPage, fetchNextPage])

  // A sealed stream has no server index (the projection skips E2E streams) and
  // no local rows either (the sync applier skips ciphertext), so the derive path
  // owns it. Route on the client-known flag, not only on the endpoint's
  // `mode: "client"` — offline or on a failed first page that answer never
  // arrives and the stream would render a permanently empty index.
  if (rootStream?.e2eEnabled || stream?.e2eEnabled || feed.mode === "client") {
    return (
      <StreamContextDerivedPanel {...props} note="This stream is encrypted — its list is built on this device only." />
    )
  }

  const isLoading = rows === undefined || (feed.isLoading && renderedRows.length === 0)
  const itemsByKey = new Map(renderedRows.map((row) => [row.key, row]))

  // The cached window ends here and the next page can't be fetched — say so
  // rather than presenting a truncated list as the whole of it (INV-11).
  // An empty cached window is exactly when the boundary matters most — there are
  // no rows to calibrate against — so it renders on both branches.
  const offlineBoundary = !isOnline && (hasNextPage || feed.isError || feed.mode === null)
  const boundaryNode = offlineBoundary ? (
    <div className="mt-2 flex items-center gap-2 rounded-md border border-dashed px-3 py-2 text-[11px] text-muted-foreground">
      <WifiOff className="size-3.5 shrink-0" />
      <span>Offline — showing what's cached on this device. Older items load when you reconnect.</span>
    </div>
  ) : null

  let body: React.ReactNode
  if (isLoading) {
    body = <ContextSkeleton />
  } else if (items.length === 0) {
    let emptyMessage: string | undefined
    if (offlineBoundary) emptyMessage = "Nothing from this stream is cached on this device yet."
    else if (searchTerms.length > 0 || supported.length > 0)
      emptyMessage = "No matches in this stream. Try fewer filters."
    body = (
      <div className="flex h-full flex-col">
        <ContextEmpty message={emptyMessage} />
        {boundaryNode}
      </div>
    )
  } else {
    body = (
      <ContextTimeline
        scrollRef={scrollerRef}
        listRef={listRef}
        onJumpToDate={jumpToDate}
        items={items}
        renderItem={(item) => (
          <ContextRowWithOccurrences
            key={item.key}
            item={item}
            row={itemsByKey.get(item.key)!}
            workspaceId={workspaceId}
            streamId={streamId}
            searchTerms={searchTerms}
            filters={{
              q: debounced.parsed.text || undefined,
              from: debounced.authorId ?? undefined,
              before: debounced.before,
              after: debounced.after,
            }}
            onJumpToMessage={onJumpToMessage}
            onOpenThread={onOpenThread}
            onOpenMemo={onOpenMemo}
            onOpenGallery={onOpenGallery}
          />
        )}
        footer={
          <>
            <div ref={sentinelRef} aria-hidden className="h-px" />
            {(isFetchingNextPage || jumping) && <ContextSkeleton />}
            {boundaryNode}
          </>
        }
      />
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <ContextPanelHeader total={total} onClose={onClose} />

      <div className="flex shrink-0 flex-col gap-1.5 border-b px-3 py-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search this stream's links, files, memories…"
            aria-label="Search in this stream"
            className="h-7 pl-7 pr-7 text-xs"
          />
          {query && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => setQuery("")}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <SearchFilterChips query={query} parsedFilters={live.parsed.filters} onQueryChange={setQuery} />
          <SearchFilterMenu
            workspaceId={workspaceId}
            query={query}
            onQueryChange={setQuery}
            kinds={["from", "after", "before"]}
            userIds={authorIds}
          />
        </div>
        {unsupported.length > 0 && (
          <p className="text-[11px] text-muted-foreground">
            {unsupported.map((f) => `${f.type}:`).join(", ")} {unsupported.length === 1 ? "is" : "are"} not supported
            here — this list is already scoped to one stream.
          </p>
        )}
        {!isOnline && (searchTerms.length > 0 || supported.length > 0) && (
          <p className="text-[11px] text-muted-foreground">Offline — searching only what's cached on this device.</p>
        )}
      </div>

      {total > 0 && (
        <ContextChipRow chips={chipsFromCounts(counts, total)} active={effectiveFilter} onSelect={setFilter} />
      )}

      <div
        ref={scrollerRef}
        // Focusable so a date jump can park focus here when the marker that
        // opened the menu is windowed out (Radix would otherwise return focus to
        // a removed node and drop it to <body>).
        tabIndex={-1}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]"
      >
        {body}
      </div>
    </div>
  )
}

/**
 * The stream's member roster as the app already holds it. A cache-only observer
 * (see `CLAUDE.md`): the stream page's own bootstrap owns this key, and a side
 * panel must not open a second subscription just to populate a menu. Prefers the
 * root's roster — a thread inherits its members (INV-62) — and falls back to the
 * stream's own for a thread opened before its root was fetched.
 */
function useCachedStreamMembers(
  workspaceId: string,
  rootStreamId: string,
  streamId: string
): StreamMember[] | undefined {
  const root = useCachedBootstrapMembers(workspaceId, rootStreamId)
  const own = useCachedBootstrapMembers(workspaceId, streamId)
  return root ?? own
}

function useCachedBootstrapMembers(workspaceId: string, streamId: string): StreamMember[] | undefined {
  const queryClient = useQueryClient()
  const key = streamKeys.bootstrap(workspaceId, streamId)
  const { data } = useQuery({
    queryKey: key,
    // Returns what the cache already holds rather than a constant: this shares a
    // key with the stream page's real bootstrap, and a `queryFn` that resolved
    // to anything else would overwrite it if this observer were ever fetched.
    queryFn: () => queryClient.getQueryData<StreamBootstrap>(key) ?? null,
    enabled: false,
    staleTime: Infinity,
    select: (bootstrap: StreamBootstrap | null) => bootstrap?.members,
  })
  return data ?? undefined
}

/**
 * The endpoint-shaped view of a query string: the supported filters resolved
 * (`from:@slug` → author id, a date → that day's bounds) and the free text split
 * into highlightable terms.
 */
function useSearchState(query: string, users: { id: string; slug: string }[]) {
  const parsed = useMemo(() => parseSearchQuery(query), [query])
  const supported = useMemo(() => parsed.filters.filter(isSupported), [parsed])
  const fromSlug = supported.find((f) => f.type === "from")?.value ?? null
  const authorId = useMemo(
    () => (fromSlug ? (users.find((u) => u.slug === fromSlug)?.id ?? null) : null),
    [fromSlug, users]
  )
  const searchTerms = useMemo(() => extractSearchTerms(parsed.text), [parsed.text])
  return {
    parsed,
    supported,
    authorId,
    before: isoBound(supported.find((f) => f.type === "before")?.value, "end"),
    after: isoBound(supported.find((f) => f.type === "after")?.value, "start"),
    searchTerms,
  }
}

/** A date filter is a day, not an instant — widen it to that day's bounds. */
function isoBound(value: string | undefined, edge: "start" | "end"): string | undefined {
  if (!value) return undefined
  const date = new Date(edge === "start" ? `${value}T00:00:00` : `${value}T23:59:59.999`)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

interface RowFilters {
  q?: string
  from?: string
  before?: string
  after?: string
}

/**
 * One feed row plus, when the server collapsed several occurrences into it, the
 * expander that lists them. The affordance is gated on a server-supplied
 * `groupKey`: a locally derived row groups by its raw `refId` and would expand
 * into the wrong set until it reconciles.
 */
function ContextRowWithOccurrences({
  item,
  row,
  workspaceId,
  streamId,
  searchTerms,
  filters,
  onJumpToMessage,
  onOpenThread,
  onOpenMemo,
  onOpenGallery,
}: {
  item: ContextItem
  row: CachedStreamContextItem
  workspaceId: string
  streamId: string
  searchTerms: string[]
  filters: RowFilters
  onJumpToMessage: (messageId: string) => void
  onOpenThread: (threadId: string) => void
  onOpenMemo: (memoId: string) => void
  onOpenGallery: (key: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const expandable = row.occurrenceCount > 1 && row._status !== "pending"

  // A thread's artifact is part of its root's context (INV-62), so opening it
  // means opening the thread first — the message isn't in the root's timeline.
  const jump = (messageId: string) => {
    if (row.streamId !== streamId) onOpenThread(row.streamId)
    onJumpToMessage(messageId)
  }

  return (
    <div>
      <StreamContextRow
        workspaceId={workspaceId}
        item={item}
        searchTerms={searchTerms}
        onJumpToMessage={jump}
        onOpenThread={onOpenThread}
        onOpenMemo={onOpenMemo}
        onOpenGallery={onOpenGallery}
      />
      <div className="flex flex-wrap items-center gap-2 pl-[3.75rem] text-[11px] text-muted-foreground">
        {row.streamId !== streamId && <ThreadOrigin workspaceId={workspaceId} threadId={row.streamId} />}
        {expandable && (
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded((prev) => !prev)}
            className="flex items-center gap-0.5 rounded hover:text-foreground"
          >
            {expanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
            Shared {row.occurrenceCount} times
          </button>
        )}
      </div>
      {expanded && (
        <OccurrenceList
          row={row}
          workspaceId={workspaceId}
          streamId={streamId}
          filters={filters}
          searchTerms={searchTerms}
          onJump={onJumpToMessage}
          onOpenThread={onOpenThread}
        />
      )}
    </div>
  )
}

function ThreadOrigin({ workspaceId, threadId }: { workspaceId: string; threadId: string }) {
  const name = useStreamName(workspaceId, threadId, "noun")
  return <span className="truncate">in {name ?? "a thread"}</span>
}

/**
 * Every occurrence of a collapsed group, read from IDB and topped up from the
 * endpoint under the same active filters the collapsed count was computed with.
 */
function OccurrenceList({
  row,
  workspaceId,
  streamId,
  filters,
  searchTerms,
  onJump,
  onOpenThread,
}: {
  row: CachedStreamContextItem
  workspaceId: string
  streamId: string
  filters: RowFilters
  searchTerms: string[]
  onJump: (messageId: string) => void
  onOpenThread: (threadId: string) => void
}) {
  const groupRef = contextGroupRef(row)
  const occurrences = useStreamContextOccurrences(workspaceId, row.rootStreamId, groupRef)
  const { formatRelative } = useFormattedDate()
  const { q, from, before, after } = filters

  useEffect(() => {
    let cancelled = false
    void streamContextApi
      .occurrences(workspaceId, streamId, {
        category: row.category,
        groupKey: row.groupKey,
        scope: "tree",
        q,
        from,
        before,
        after,
      })
      .then((response) => {
        if (cancelled) return
        return seedStreamContextItems(workspaceId, row.rootStreamId, response.items)
      })
      .catch(() => {
        // Offline / failed: the IDB occurrences below are still shown, which is
        // the same "cached window only" boundary the feed draws.
      })
    return () => {
      cancelled = true
    }
  }, [workspaceId, streamId, row.category, row.groupKey, row.rootStreamId, q, from, before, after])

  // IDB holds every occurrence ever seeded for the group, including ones an
  // earlier unfiltered fetch brought in, so the text filter has to be applied
  // here too or the list outgrows the collapsed count it was labelled with.
  const visible = filterContextRows(occurrences ?? [], {
    terms: searchTerms,
    authorId: from,
    before,
    after,
  })

  return (
    <ul className="ml-[3.75rem] mt-1 space-y-0.5 border-l pl-3">
      {visible.map((occurrence) => (
        <li key={occurrence.key}>
          <button
            type="button"
            disabled={!(occurrence.sourceMessageId ?? occurrence.anchorEventId)}
            onClick={() => {
              const target = occurrence.sourceMessageId ?? occurrence.anchorEventId
              if (!target) return
              if (occurrence.streamId !== streamId) onOpenThread(occurrence.streamId)
              onJump(target)
            }}
            className={cn(
              "flex w-full items-center gap-2 rounded px-1 py-0.5 text-left text-[11px] text-muted-foreground",
              occurrence.sourceMessageId ? "hover:bg-accent/50 hover:text-foreground" : "opacity-60"
            )}
          >
            <span className="shrink-0 tabular-nums">
              {formatRelative(new Date(occurrence.occurredAt), undefined, { terse: true })}
            </span>
            <span className="truncate">{occurrence.snippet || "Go to message"}</span>
          </button>
        </li>
      ))}
    </ul>
  )
}
