import { useEffect, useMemo, useRef, useState } from "react"
import { AlertCircle, ArrowLeft, ArrowUp, LayoutGrid } from "lucide-react"
import { Link, Navigate, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom"
import { Button, buttonVariants } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Skeleton } from "@/components/ui/skeleton"
import { ThreadPanelSlot } from "@/components/layout"
import { PanelHost } from "@/components/layout/panel-host"
import { SidebarToggle } from "@/components/layout/sidebar-toggle"
import { usePanel, useSidebar } from "@/contexts"
import { usePanelLayout } from "@/hooks"
import { useFeatureFlagWhenKnown } from "@/hooks/use-feature-flags"
import { resolveStreamName } from "@/lib/streams"
import { localStartOfDayMs } from "@/lib/dates"
import {
  useWorkspaceStreams,
  useWorkspaceUsers,
  useWorkspaceDmPeers,
  useWorkspaceLabelAssignments,
} from "@/stores/workspace-store"
import { useStableBoardView, type BoardViewFilter, type BoardViewPost } from "@/hooks/use-stable-board-view"
import { selectLabeledStreamIds } from "@/hooks/use-labels"
import { useBoardStreamSubscriptions } from "@/hooks/use-board-stream-subscriptions"
import { BOARD_CARD_ATTR, useBoardScrollAnchor } from "@/hooks/use-board-scroll-anchor"
import {
  useWorkspaceConversations,
  useBoardExclusions,
  useMuteStream,
  useUnmuteStream,
} from "@/hooks/use-conversations"
import { useBoardHiddenConversations, useBoardMutedStreamIds } from "@/stores/board-exclusions-store"
import { useBoardRailsReady } from "@/hooks/use-board-card-messages"
import { useConversationGraphReady } from "@/hooks/use-conversation-graph"
import { SKELETON_DELAY_MS } from "@/contexts/coordinated-loading-context"
import { BoardCard } from "@/components/board/board-card"
import { BoardComposer } from "@/components/board/board-composer"
import { BoardFilterBar } from "@/components/board/board-filter-bar"
import {
  BOARD_SCOPE_PARAM,
  BOARD_TYPE_PARAM,
  BOARD_LABEL_PARAM,
  BOARD_EXCLUDE_SCOPE_PARAM,
  BOARD_EXCLUDE_TYPE_PARAM,
  BOARD_EXCLUDE_LABEL_PARAM,
  BOARD_ARCHIVED_PARAM,
  BOARD_ARCHIVED_ON,
  boardHomeSearch,
  parseIdListParam,
  parseTypeListParam,
} from "@/components/board/board-filter-params"
import { cn } from "@/lib/utils"
import {
  BOARD_LENSES,
  DEFAULT_BOARD_LENS,
  MAX_BOARD_SCOPE_STREAMS,
  MAX_BOARD_SCOPE_LABELS,
  type BoardLens,
  type BoardScopeStreamType,
  type ConversationWithStaleness,
} from "@threa/types"

const VALID_LENSES = new Set<string>(BOARD_LENSES)

/** How many leading cards' rails the reveal gate pre-warms before first paint.
 *  Covers the viewport with margin; cards past it mount against already-warm or
 *  fast-resolving rails below the fold, where late resolution can't shift
 *  anything the viewer sees. */
const REVEAL_PREWARM_CARDS = 12

/** Empty-state copy per lens — an empty Decisions view isn't "nothing on the board". */
const LENS_EMPTY_COPY: Record<BoardLens, { title: string; body: string }> = {
  all: {
    title: "Nothing on the board yet",
    body: "As your conversations build up, the topics worth returning to surface here, newest activity first.",
  },
  active: {
    title: "Nothing in motion",
    body: "Conversations that are still being worked — not stalled, not resolved — show up here.",
  },
  "needs-resolution": {
    title: "No loose ends",
    body: "Conversations that stall or go quiet while unresolved show up here. Nothing needs picking back up right now.",
  },
  decisions: {
    title: "No decisions captured yet",
    body: "When a conversation produces a memo — a decision, a fact worth keeping — it surfaces here as settled knowledge.",
  },
  mine: {
    title: "Nothing here for you yet",
    body: "Conversations you start, join, or get mentioned in surface here — the slice of the board that's yours.",
  },
}

/** Copy for an empty filtered view, whatever the lens — the filters, not the
 *  board, are what's empty, and the CTA below it clears them. */
const SCOPED_EMPTY_COPY = {
  title: "Nothing here right now",
  body: "No conversations match the current filters.",
}

/**
 * Coarse recency bucket for a post's last activity, in device-local time
 * (INV-42). The board is ordered by activity desc, so consecutive posts fall into
 * monotonic buckets — grouping them gives the feed structure without disturbing
 * the recency order. Day boundaries, not 24h windows, so "Yesterday" matches the
 * user's calendar.
 */
function recencyBucket(activityMs: number, nowMs: number): string {
  const daysAgo = Math.round(
    (localStartOfDayMs(new Date(nowMs)) - localStartOfDayMs(new Date(activityMs))) / 86_400_000
  )
  if (daysAgo <= 0) return "Today"
  if (daysAgo === 1) return "Yesterday"
  if (daysAgo <= 6) return "Earlier this week"
  if (daysAgo <= 30) return "This month"
  return "Older"
}

interface BoardSection {
  label: string
  posts: BoardViewPost[]
}

/**
 * Fold the frozen feed into consecutive buckets, preserving order. Grouping reads
 * the commit-time activity (`activityById`), not the live `lastActivityAt`, so a
 * card bumped while the view is held keeps its section as well as its position —
 * the sections stay monotonic with the frozen order.
 */
function groupByRecency(posts: BoardViewPost[], activityById: Map<string, number>, nowMs: number): BoardSection[] {
  const sections: BoardSection[] = []
  for (const post of posts) {
    const ms = activityById.get(post.conversation.id) ?? Date.parse(post.conversation.lastActivityAt)
    const label = recencyBucket(ms, nowMs)
    const last = sections[sections.length - 1]
    if (last?.label === label) last.posts.push(post)
    else sections.push({ label, posts: [post] })
  }
  return sections
}

/**
 * The board: a cross-stream feed of posts (each conversation surfaced as a
 * message-led post) ordered by recent activity, grouped into recency sections.
 *
 * Route is `/w/:workspaceId/board/:lens?` — bare `/board` is **All**, the
 * default home: everything, always, never hidden behind a filter. The lens
 * segments (`/board/active`, `/board/needs-resolution`, `/board/decisions`)
 * are optional narrowings picked from the filter bar
 * (board-view-design.md § "Lenses"); the stream scope rides `?in=`. Refreshes,
 * back/forward, and shared links land on the same view (INV-59). `all`
 * canonicalises to the unsegmented URL (keeping the query string) so there
 * aren't two URLs for the default; an unknown segment redirects to it.
 */
export function BoardPage() {
  const { workspaceId, lens: lensParam } = useParams<{ workspaceId: string; lens?: string }>()
  const location = useLocation()
  if (!workspaceId) return null
  if (lensParam === DEFAULT_BOARD_LENS) {
    return <Navigate to={{ pathname: `/w/${workspaceId}/board`, search: location.search }} replace />
  }
  if (lensParam !== undefined && !VALID_LENSES.has(lensParam)) {
    return <Navigate to={{ pathname: `/w/${workspaceId}/board`, search: location.search }} replace />
  }
  const lens: BoardLens = (lensParam as BoardLens | undefined) ?? DEFAULT_BOARD_LENS
  return <BoardPageGate workspaceId={workspaceId} lens={lens} />
}

/**
 * The board is gated behind the `board-view` feature flag. While the bootstrap
 * (and thus the flag) is still unknown, render nothing rather than redirect —
 * redirecting on the default would bounce a flagged user who deep-links or
 * refreshes on /board before the bootstrap cache is populated. The backend
 * endpoint 404s without the flag too, so this is the UX half of the gate.
 */
function BoardPageGate({ workspaceId, lens }: { workspaceId: string; lens: BoardLens }) {
  const boardFlag = useFeatureFlagWhenKnown(workspaceId, "board-view")
  if (boardFlag === null) return null
  if (boardFlag !== "on") return <Navigate to={`/w/${workspaceId}`} replace />
  return <BoardPageInner workspaceId={workspaceId} lens={lens} />
}

function BoardPageInner({ workspaceId, lens }: { workspaceId: string; lens: BoardLens }) {
  const { isMobile } = useSidebar()
  const { isPanelOpen, closePanel } = usePanel()
  // The board's filters live in the URL (INV-59) — six params, three dimensions
  // × include/exclude, parsed here and rewritten by the filter bar's toggles.
  // Id lists are deduped and capped at the shared server limits so a hand-built
  // URL can't produce a request the backend rejects; type tokens outside the
  // root grains are dropped rather than 400ing the fetch.
  const [searchParams, setSearchParams] = useSearchParams()
  const scopeParam = searchParams.get(BOARD_SCOPE_PARAM) ?? ""
  const scopeStreamIds = useMemo(() => parseIdListParam(scopeParam).slice(0, MAX_BOARD_SCOPE_STREAMS), [scopeParam])
  const excludeScopeParam = searchParams.get(BOARD_EXCLUDE_SCOPE_PARAM) ?? ""
  const excludeStreamIds = useMemo(
    () => parseIdListParam(excludeScopeParam).slice(0, MAX_BOARD_SCOPE_STREAMS),
    [excludeScopeParam]
  )
  const typeParam = searchParams.get(BOARD_TYPE_PARAM) ?? ""
  const scopeStreamTypes = useMemo(() => parseTypeListParam(typeParam), [typeParam])
  const excludeTypeParam = searchParams.get(BOARD_EXCLUDE_TYPE_PARAM) ?? ""
  const excludeStreamTypes = useMemo(() => parseTypeListParam(excludeTypeParam), [excludeTypeParam])
  const labelParam = searchParams.get(BOARD_LABEL_PARAM) ?? ""
  const scopeLabelIds = useMemo(() => parseIdListParam(labelParam).slice(0, MAX_BOARD_SCOPE_LABELS), [labelParam])
  const excludeLabelParam = searchParams.get(BOARD_EXCLUDE_LABEL_PARAM) ?? ""
  const excludeLabelIds = useMemo(
    () => parseIdListParam(excludeLabelParam).slice(0, MAX_BOARD_SCOPE_LABELS),
    [excludeLabelParam]
  )
  // Archived is a broadening opt-in (`?archived=true`), not an id-list narrowing.
  const showArchived = searchParams.get(BOARD_ARCHIVED_PARAM) === BOARD_ARCHIVED_ON
  const scopeKey = useMemo(() => [...scopeStreamIds].sort().join(","), [scopeStreamIds])
  const excludeScopeKey = useMemo(() => [...excludeStreamIds].sort().join(","), [excludeStreamIds])
  const typeKey = useMemo(() => [...scopeStreamTypes].sort().join(","), [scopeStreamTypes])
  const excludeTypeKey = useMemo(() => [...excludeStreamTypes].sort().join(","), [excludeStreamTypes])
  const labelKey = useMemo(() => [...scopeLabelIds].sort().join(","), [scopeLabelIds])
  const excludeLabelKey = useMemo(() => [...excludeLabelIds].sort().join(","), [excludeLabelIds])

  // Label filters resolve to the streams the viewer's own assignments cover —
  // the client half of the server's anchor-or-root label match. Resolution is
  // live (an assignment changing re-filters the feed) but the view-reset key is
  // the label SELECTION, so a re-resolution never resets the frozen view.
  const labelAssignments = useWorkspaceLabelAssignments(workspaceId)
  const labelStreamIds = useMemo(
    () => selectLabeledStreamIds(labelAssignments, scopeLabelIds),
    [labelAssignments, scopeLabelIds]
  )
  const excludeLabelStreamIds = useMemo(
    () => selectLabeledStreamIds(labelAssignments, excludeLabelIds),
    [labelAssignments, excludeLabelIds]
  )

  const filter = useMemo<BoardViewFilter>(
    () => ({
      lens,
      scope: scopeStreamIds.length > 0 ? { key: scopeKey, ids: new Set(scopeStreamIds) } : null,
      types: scopeStreamTypes.length > 0 ? { key: typeKey, ids: new Set(scopeStreamTypes) } : null,
      excludeStreams: excludeStreamIds.length > 0 ? { key: excludeScopeKey, ids: new Set(excludeStreamIds) } : null,
      excludeTypes: excludeStreamTypes.length > 0 ? { key: excludeTypeKey, ids: new Set(excludeStreamTypes) } : null,
      labels: labelStreamIds ? { key: labelKey, streamIds: labelStreamIds } : null,
      excludeLabels: excludeLabelStreamIds ? { key: excludeLabelKey, streamIds: excludeLabelStreamIds } : null,
      showArchived,
    }),
    [
      lens,
      scopeKey,
      scopeStreamIds,
      typeKey,
      scopeStreamTypes,
      excludeScopeKey,
      excludeStreamIds,
      excludeTypeKey,
      excludeStreamTypes,
      labelKey,
      labelStreamIds,
      excludeLabelKey,
      excludeLabelStreamIds,
      showArchived,
    ]
  )
  // One URL write per toggle: a dimension's include/exclude params are rewritten
  // together so moving an id between the two sides is a single history entry.
  const setParamLists = (entries: Array<[param: string, values: string[]]>) => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        for (const [param, values] of entries) {
          if (values.length > 0) next.set(param, values.join(","))
          else next.delete(param)
        }
        return next
      },
      { replace: true }
    )
  }
  const setStreamFilter = (include: string[], exclude: string[]) =>
    setParamLists([
      [BOARD_SCOPE_PARAM, include],
      [BOARD_EXCLUDE_SCOPE_PARAM, exclude],
    ])
  const setTypeFilter = (include: BoardScopeStreamType[], exclude: BoardScopeStreamType[]) =>
    setParamLists([
      [BOARD_TYPE_PARAM, include],
      [BOARD_EXCLUDE_TYPE_PARAM, exclude],
    ])
  const setLabelFilter = (include: string[], exclude: string[]) =>
    setParamLists([
      [BOARD_LABEL_PARAM, include],
      [BOARD_EXCLUDE_LABEL_PARAM, exclude],
    ])
  const setShowArchived = (next: boolean) => setParamLists([[BOARD_ARCHIVED_PARAM, next ? [BOARD_ARCHIVED_ON] : []]])
  const {
    containerRef,
    panelWidth,
    maxWidth,
    minWidth,
    displayWidth,
    shouldAnimate,
    isResizing,
    showContent,
    handleResizeStart,
    handleResizeKeyDown,
    handleTransitionEnd,
  } = usePanelLayout(isPanelOpen)

  // The query is the fetch/seed engine; the board reads reactively from IDB. The
  // stable-view projection holds the order the viewer is looking at frozen and
  // accumulates live changes behind the "N new" pill (INV-61, extended from the
  // timeline's insertion rule to the board's ordering).
  const { data, isLoading, isError, refetch, fetchNextPage, hasNextPage, isFetchingNextPage, isFetchNextPageError } =
    useWorkspaceConversations(workspaceId, {
      lens,
      streams: scopeStreamIds,
      types: scopeStreamTypes,
      excludeStreams: excludeStreamIds,
      excludeTypes: excludeStreamTypes,
      labels: scopeLabelIds,
      excludeLabels: excludeLabelIds,
      showArchived,
      limit: 50,
    })

  // Per-viewer hide/mute (board-view-design.md § "Hide & mute"): bootstrap the
  // exclusion sets into IDB, read them reactively, and fold them into the view.
  // Mute is skipped under an explicit `?in=` stream scope (the viewer named those
  // streams), matching the server's `applyMute` rule.
  useBoardExclusions(workspaceId)
  const hidden = useBoardHiddenConversations(workspaceId)
  const muted = useBoardMutedStreamIds(workspaceId)
  const muteStream = useMuteStream(workspaceId)
  const unmuteStream = useUnmuteStream(workspaceId)
  const exclusions = useMemo(
    () => ({ hidden, muted, muteActive: scopeStreamIds.length === 0 }),
    [hidden, muted, scopeStreamIds.length]
  )
  const {
    posts,
    activityById,
    newCount,
    commit,
    revealNext,
    isLoading: viewLoading,
    hasRawPosts,
  } = useStableBoardView(workspaceId, filter, exclusions)
  // After a refetch settles, `isLoading` is already false but the seed effect
  // writes IDB on the next tick, so the IDB feed can be momentarily empty while
  // the query already holds posts. Treat that window as loading so the feed
  // doesn't flash the empty state before the seed lands. `!hasRawPosts` scopes
  // this to a genuinely-unseeded feed: once IDB has rows, filtering them all away
  // (hide/mute/lens down to zero) is a real empty view, not a pending seed.
  const seedPending = !hasRawPosts && (data?.pages.some((page) => page.posts.length > 0) ?? false) && posts.length === 0
  // Keep the streams behind on-screen cards live + offline-first (threads and
  // public channels the viewer never joined aren't subscribed at bootstrap).
  useBoardStreamSubscriptions(posts)
  // Coordinated reveal: hold the first card paint until the above-fold cards'
  // rails AND the conversation graph have completed their first IDB read, so a
  // card's first frame is its final frame — no skeleton→card swap, no branch
  // replies or agent rows resolving in afterwards (content never shifts unless
  // content actually changed — Kris's refresh ruling, 2026-07-05). Warm-device
  // holds are one IDB round-trip; the skeleton appears only past the same delay
  // the timeline uses, so the common path is blank-for-a-beat → complete board.
  const prewarmStreamIds = useMemo(() => {
    const set = new Set<string>()
    for (const post of posts.slice(0, REVEAL_PREWARM_CARDS)) {
      set.add(post.conversation.streamId)
      for (const id of post.streamIds ?? []) set.add(id)
    }
    return [...set].sort()
  }, [posts])
  const railsReady = useBoardRailsReady(prewarmStreamIds)
  const graphReady = useConversationGraphReady(workspaceId)
  const revealReady = railsReady && graphReady
  const holding = posts.length > 0 && !revealReady
  const loading = isLoading || viewLoading || seedPending || holding
  const [skeletonVisible, setSkeletonVisible] = useState(false)
  useEffect(() => {
    if (!loading) {
      setSkeletonVisible(false)
      return
    }
    const timer = setTimeout(() => setSkeletonVisible(true), SKELETON_DELAY_MS)
    return () => clearTimeout(timer)
  }, [loading])
  const streams = useWorkspaceStreams(workspaceId)
  const users = useWorkspaceUsers(workspaceId)
  const dmPeers = useWorkspaceDmPeers(workspaceId)
  const streamById = useMemo(() => new Map(streams.map((s) => [s.id, s])), [streams])
  const sections = useMemo(() => groupByRecency(posts, activityById, Date.now()), [posts, activityById])

  // Resolve the Radix scroll viewport (the scroller) once it mounts, for the
  // scroll anchor and the pill's scroll-to-top reveal.
  const scrollRootRef = useRef<HTMLDivElement>(null)
  const [viewport, setViewport] = useState<HTMLElement | null>(null)
  useEffect(() => {
    setViewport(scrollRootRef.current?.querySelector<HTMLElement>("[data-radix-scroll-area-viewport]") ?? null)
  }, [])
  // Pass the whole filter as the reset key so changing lens OR scope drops the
  // previous view's scroll anchor and starts the new (often much shorter)
  // subset at the top, pre-paint — otherwise a viewer scrolled down the All
  // wall who taps Decisions lands past the end of a one-card list.
  useBoardScrollAnchor(
    viewport,
    `${lens}|${scopeKey}|${typeKey}|${excludeScopeKey}|${excludeTypeKey}|${labelKey}|${excludeLabelKey}|${showArchived ? "arch" : ""}`
  )

  const revealNew = () => {
    // Jump to the top first so the freshly-committed cards flow in where the
    // viewer can see them; the anchor stays out of the way near the top.
    if (viewport) viewport.scrollTop = 0
    commit()
  }

  const navigate = useNavigate()
  // Every route back to the unfiltered home keeps the non-filter query state
  // (an open `?panel=` must survive clearing filters).
  const boardHome = { pathname: `/w/${workspaceId}/board`, search: boardHomeSearch(searchParams.toString()) }
  const hasFilterParams =
    scopeStreamIds.length > 0 ||
    scopeStreamTypes.length > 0 ||
    excludeStreamIds.length > 0 ||
    excludeStreamTypes.length > 0 ||
    scopeLabelIds.length > 0 ||
    excludeLabelIds.length > 0
  const handlePosted = () => {
    // The viewer's own post must ALWAYS surface — but a filtered view might not
    // match it (a fresh post is no Decision). Posting from a filtered board
    // returns to the All home first; the reveal arm survives the view reset, so
    // the authored card shows up top instead of hiding behind a filter.
    if (lens !== DEFAULT_BOARD_LENS || hasFilterParams) {
      navigate(boardHome)
    }
    revealNext()
  }

  // Where the post lives — the stream's own name (channel #slug, DM peer,
  // scratchpad name), used as the card's locator. The glyph follows the type.
  function labelsFor(conversation: ConversationWithStaleness): {
    contextLabel: string
    streamType: string | undefined
  } {
    const streamName = resolveStreamName(conversation.streamId, { streams, users, dmPeers }, "generic")
    return {
      contextLabel: streamName ?? "Unknown stream",
      streamType: streamById.get(conversation.streamId)?.type,
    }
  }

  // Flat if-chain, not a nested ternary (INV-47 / no-nested-ternary).
  let loadMoreLabel = "Load more"
  if (isFetchingNextPage) loadMoreLabel = "Loading…"
  else if (isFetchNextPageError) loadMoreLabel = "Retry"

  // Prefer cached/live content: a transient refetch error never hides a feed we
  // already have. Cards render only once the reveal gate clears (rails + graph
  // resolved) so the first paint is complete; the skeleton earns its slot only
  // past SKELETON_DELAY_MS of genuine loading (cold device), never as a flash on
  // a warm refresh. Empty state only once IDB has resolved to genuinely nothing.
  let content
  if (posts.length > 0 && revealReady) {
    content = (
      <div className="flex flex-col">
        {sections.map((section) => (
          <section key={section.label} className="mb-4">
            <h2 className="px-1 pb-1.5 pt-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              {section.label}
            </h2>
            <div className="flex flex-col gap-3">
              {section.posts.map((post) => {
                const { contextLabel, streamType } = labelsFor(post.conversation)
                return (
                  <div key={post.conversation.id} {...{ [BOARD_CARD_ATTR]: post.conversation.id }}>
                    <BoardCard
                      workspaceId={workspaceId}
                      post={post}
                      contextLabel={contextLabel}
                      streamType={streamType}
                    />
                  </div>
                )
              })}
            </div>
          </section>
        ))}
        {hasNextPage && (
          <div className="mt-1 flex flex-col items-center gap-1">
            {isFetchNextPageError && <p className="text-xs text-destructive">Couldn't load more.</p>}
            <Button
              variant="ghost"
              onClick={() => fetchNextPage()}
              disabled={isFetchingNextPage}
              className="min-h-11 px-6"
            >
              {loadMoreLabel}
            </Button>
          </div>
        )}
      </div>
    )
  } else if (isError && posts.length === 0) {
    // A failed fetch must read as a failure, not as the empty state's upbeat
    // copy — but cached content mid-reveal still outranks it (the hold above
    // resolves in one IDB round-trip; erroring over a full cache would flash).
    content = (
      <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
        <AlertCircle className="h-8 w-8 text-destructive" />
        <p className="text-sm font-medium">Couldn't load the board</p>
        <p className="max-w-sm text-sm text-muted-foreground">Something went wrong fetching your conversations.</p>
        <Button variant="outline" onClick={() => refetch()} className="min-h-11">
          Try again
        </Button>
      </div>
    )
  } else if (loading) {
    content = skeletonVisible ? (
      <div className="flex flex-col gap-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="rounded-xl border bg-card p-4">
            <Skeleton className="h-3 w-1/3" />
            <div className="mt-3 flex items-start gap-2">
              <Skeleton className="h-8 w-8 shrink-0 rounded-[8px]" />
              <div className="min-w-0 flex-1 space-y-2">
                <Skeleton className="h-3.5 w-1/4" />
                <Skeleton className="h-3 w-4/5" />
              </div>
            </div>
          </div>
        ))}
      </div>
    ) : null
  } else {
    // A filtered-empty view is the FILTERS coming up empty, never the board
    // hiding things — so it always offers the one-tap way back to everything.
    const scoped = hasFilterParams
    const isFiltered = lens !== DEFAULT_BOARD_LENS || scoped
    const copy = scoped ? SCOPED_EMPTY_COPY : LENS_EMPTY_COPY[lens]
    content = (
      <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center">
        <LayoutGrid className="h-8 w-8 text-muted-foreground" />
        <p className="text-sm font-medium">{copy.title}</p>
        <p className="max-w-sm text-sm text-muted-foreground">{copy.body}</p>
        {isFiltered && (
          <Link to={boardHome} className={cn(buttonVariants({ variant: "outline" }), "mt-1 min-h-11")}>
            Show everything
          </Link>
        )}
      </div>
    )
  }

  const boardColumn = (
    <div className="flex h-full flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
        <SidebarToggle location="page" />
        <Link
          to={`/w/${workspaceId}`}
          className={cn(buttonVariants({ variant: "ghost", size: "icon" }), "h-8 w-8 shrink-0")}
          aria-label="Back to workspace"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <LayoutGrid className="h-5 w-5 shrink-0 text-muted-foreground" />
        <h1 className="truncate font-semibold">Board</h1>
      </header>
      <BoardFilterBar
        workspaceId={workspaceId}
        lens={lens}
        scopeStreamIds={scopeStreamIds}
        excludeStreamIds={excludeStreamIds}
        onStreamFilterChange={setStreamFilter}
        scopeStreamTypes={scopeStreamTypes}
        excludeStreamTypes={excludeStreamTypes}
        onTypeFilterChange={setTypeFilter}
        scopeLabelIds={scopeLabelIds}
        excludeLabelIds={excludeLabelIds}
        onLabelFilterChange={setLabelFilter}
        mutedStreamIds={muted}
        onToggleMute={(streamId, mute) => (mute ? muteStream.mutate(streamId) : unmuteStream.mutate(streamId))}
        showArchived={showArchived}
        onToggleArchived={setShowArchived}
      />
      <span className="sr-only" role="status" aria-live="polite">
        {newCount > 0 ? `${newCount} new ${newCount === 1 ? "post" : "posts"} available` : ""}
      </span>
      <div className="relative flex-1 overflow-hidden">
        <ScrollArea ref={scrollRootRef} className="h-full [&>div>div]:!block [&>div>div]:!w-full">
          <main className="mx-auto w-full max-w-[800px] px-2 py-3 sm:px-4">
            <BoardComposer workspaceId={workspaceId} onPosted={handlePosted} />
            {/* Sticky banner row between the composer and the feed: an in-flow
                row (its own height, so it never overlaps the first card's tap
                targets) that sticks to the top edge once scrolled in, keeping the
                reveal reachable. The transparent row lets the feed scroll behind
                it; only the centered button takes taps. */}
            {newCount > 0 && (
              <div className="pointer-events-none sticky top-2 z-10 mb-1 flex min-h-11 items-center justify-center">
                <Button
                  size="sm"
                  onClick={revealNew}
                  aria-label={`Show ${newCount} new ${newCount === 1 ? "post" : "posts"}`}
                  className="pointer-events-auto min-h-11 gap-1.5 rounded-full px-4 shadow-md"
                >
                  <ArrowUp className="h-3.5 w-3.5" aria-hidden="true" />
                  {newCount} new
                </Button>
              </div>
            )}
            {content}
          </main>
        </ScrollArea>
      </div>
    </div>
  )

  // Mobile: an open conversation panel takes over the full screen (mirrors the
  // stream page), so the narrow board feed isn't crushed beside it.
  if (isMobile && isPanelOpen) {
    return (
      <div className="flex h-full flex-col">
        <PanelHost workspaceId={workspaceId} onClose={closePanel} />
      </div>
    )
  }

  return (
    <div ref={containerRef} className="flex h-full">
      <div className="min-w-0 flex-1 overflow-hidden">{boardColumn}</div>
      <ThreadPanelSlot
        displayWidth={displayWidth}
        panelWidth={panelWidth}
        shouldAnimate={shouldAnimate}
        showContent={showContent}
        isResizing={isResizing}
        maxWidth={maxWidth}
        minWidth={minWidth}
        onTransitionEnd={handleTransitionEnd}
        onResizeStart={handleResizeStart}
        onResizeKeyDown={handleResizeKeyDown}
      >
        <PanelHost workspaceId={workspaceId} onClose={closePanel} />
      </ThreadPanelSlot>
    </div>
  )
}
