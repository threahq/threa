import { useEffect, useMemo, useRef, useState } from "react"
import { ChevronDown, ChevronRight, Search, WifiOff, X } from "lucide-react"
import { streamContextApi } from "@/api"
import { useIsOnline } from "@/components/layout/connection-status"
import { extractSearchTerms } from "@/components/search/highlight"
import { SearchFilterChips } from "@/components/search/search-filter-chips"
import { SearchFilterMenu } from "@/components/search/search-filter-menu"
import { SEARCH_DEBOUNCE_MS } from "@/components/search/use-message-search"
import { Input } from "@/components/ui/input"
import { useFormattedDate } from "@/hooks"
import { useStreamName } from "@/hooks/use-stream-name"
import { parseSearchQuery, type ParsedFilter } from "@/lib/search-query-parser"
import { contextItemFromCached } from "@/lib/stream-context/from-cached"
import { collapseContextRows, countByCategory, filterContextRows } from "@/lib/stream-context/filter"
import type { ContextCategory, ContextItem } from "@/lib/stream-context/types"
import { cn } from "@/lib/utils"
import {
  contextGroupRef,
  seedStreamContextItems,
  useStreamContextOccurrences,
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

  const sentinelRef = useRef<HTMLDivElement | null>(null)
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

  const isLoading = rows === undefined || (feed.isLoading && visibleRows.length === 0)
  const items = visibleRows.map(contextItemFromCached).filter((item): item is ContextItem => item !== null)
  const itemsByKey = new Map(visibleRows.map((row) => [row.key, row]))

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
            {isFetchingNextPage && <ContextSkeleton />}
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

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        {body}
      </div>
    </div>
  )
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
