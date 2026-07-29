import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react"
import type { VirtualizerHandle } from "virtua"
import { AlertCircle, ArrowLeft, LayoutGrid, PenLine } from "lucide-react"
import { Link, Navigate, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom"
import { Button, buttonVariants } from "@/components/ui/button"
import { ThreadPanelSlot } from "@/components/layout"
import { PanelHost } from "@/components/layout/panel-host"
import { SidebarToggle } from "@/components/layout/sidebar-toggle"
import { usePanel, usePreferencesOptional, useSidebar } from "@/contexts"
import { usePanelLayout } from "@/hooks"
import { resolveStreamName } from "@/lib/streams"
import { localStartOfDayMs } from "@/lib/dates"
import {
  useWorkspaceStreams,
  useWorkspaceUsers,
  useWorkspaceDmPeers,
  useWorkspaceLabelAssignments,
  useWorkspaceUnreadState,
} from "@/stores/workspace-store"
import { useStableBoardView, type BoardViewFilter, type BoardViewPost } from "@/hooks/use-stable-board-view"
import { selectLabeledStreamIds } from "@/hooks/use-labels"
import { useBoardStreamSubscriptions } from "@/hooks/use-board-stream-subscriptions"
import { useWorkspaceConversations, useBoardExclusions } from "@/hooks/use-conversations"
import { useBoardHiddenConversations, useBoardMutedStreamIds } from "@/stores/board-exclusions-store"
import { useBoardRailsReady } from "@/hooks/use-board-card-messages"
import { useBoardRevealLatch } from "@/hooks/use-board-reveal-latch"
import {
  useConversationGraph,
  useConversationGraphReady,
  useStreamStructuralIndex,
  collectBranchThreadStreamIds,
} from "@/hooks/use-conversation-graph"
import { useBoardDraftsReady } from "@/hooks/use-scope-draft-preview"
import { useCoordinatedPhase } from "@/contexts/coordinated-loading-context"
import { FloatingComposerAnchorProvider, FLOATING_COMPOSER_HEIGHT_VAR } from "@/components/composer"
import { BoardCard, BoardCardSkeleton } from "@/components/board/board-card"
import { BoardFeedList } from "@/components/board/board-feed-list"
import { BoardNewPostsPill } from "@/components/board/board-new-posts-pill"
import { openCompose, registerComposeOnPosted } from "@/stores/compose-overlay-store"
import { setBoardFlash } from "@/stores/board-flash-store"
import { boardHomeHref } from "@/components/board/board-saved-views"
import { useBoardViews } from "@/hooks/use-board-views"
import { isBoardFiltered } from "@/lib/board/filter-state"
import {
  BOARD_LENS_PARAM,
  BOARD_SCOPE_PARAM,
  BOARD_TYPE_PARAM,
  BOARD_LABEL_PARAM,
  BOARD_EXCLUDE_SCOPE_PARAM,
  BOARD_EXCLUDE_TYPE_PARAM,
  BOARD_EXCLUDE_LABEL_PARAM,
  BOARD_ARCHIVED_PARAM,
  BOARD_ARCHIVED_ON,
  BOARD_UNREAD_PARAM,
  BOARD_UNREAD_ON,
  clearFiltersSearch,
  parseIdListParam,
  parseLensParam,
  parseTypeListParam,
} from "@/components/board/board-filter-params"
import { cn } from "@/lib/utils"
import {
  DEFAULT_BOARD_LENS,
  MAX_BOARD_SCOPE_STREAMS,
  MAX_BOARD_SCOPE_LABELS,
  type BoardLens,
  type ConversationWithStaleness,
} from "@threa/types"

/** Lenses that always contain the viewer's own fresh post: `all` (everything)
 *  and `mine` (a self-authored conversation is `isMine`). The status/memo lenses
 *  gate on classification a brand-new post may not have yet, so posting from
 *  those routes back to All so the author's card always surfaces. */
const SELF_POST_VISIBLE_LENSES = new Set<BoardLens>(["all", "mine"])

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
 * Route is `/w/:workspaceId/board`; the whole view is query state (INV-59). The
 * lens rides `?lens=` (`all`, `active`, `needs-resolution`, `decisions`, `mine`
 * — board-view-design.md § "Lenses"; absent or unknown degrades to `all`), the
 * stream scope rides `?in=`, and every rendered board URL carries an explicit
 * `?lens=`. The bare query-less `/board` is only an entry alias: it redirects
 * once to the viewer's home — the pinned saved view (`boardDefaultViewId`) or
 * the home lens (`boardDefaultLens`) — expanded to its explicit URL. Because no
 * rendered URL is ever the bare path, no filter affordance can re-trigger the
 * home resolution: "Clear filters" targets `?lens=all` and sticks.
 */
export function BoardPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>()
  const location = useLocation()
  const preferences = usePreferencesOptional()
  const homeLens = preferences?.preferences?.boardDefaultLens ?? DEFAULT_BOARD_LENS
  const defaultViewId = preferences?.preferences?.boardDefaultViewId ?? null
  // Already mounted deeper (the lens menu), so this adds no fetch — it just lets
  // the entry alias resolve a saved-view home.
  const { data: boardViews, isError: boardViewsFailed } = useBoardViews(workspaceId ?? "")
  if (!workspaceId) return null
  if (location.search === "") {
    // The entry alias: resolve where home is, then redirect to its explicit URL.
    // Hold (render nothing) until home is knowable rather than paint the default
    // board and bounce a frame later. `usePreferencesOptional()` returns its
    // context object as soon as the provider mounts, so read `.preferences` (the
    // IDB data, null until it hydrates) — otherwise a cold load misreads a
    // saved-view home as unset and lands on the wrong lens. The saved-view LIST
    // is only needed when a default view id is actually set, so a plain-lens
    // home doesn't block on the board-views query; a FAILED list also counts as
    // "ready" (the id can't resolve — degrade to the home lens and render rather
    // than hold `/board` blank forever on a network blip).
    const homeReady =
      preferences?.preferences != null && (defaultViewId === null || boardViews !== undefined || boardViewsFailed)
    if (!homeReady) return null
    return <Navigate to={boardHomeHref(workspaceId, defaultViewId, boardViews, homeLens)} replace />
  }
  const lens = parseLensParam(new URLSearchParams(location.search).get(BOARD_LENS_PARAM))
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
  const [searchParams] = useSearchParams()
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
  // Unread is a narrowing opt-in (`?unread=true`), resolved client-side to the
  // same "unread and not muted" membership the sidebar's Unread section uses —
  // no backend round-trip, so it stays live as things get read without a refetch.
  const unreadOnly = searchParams.get(BOARD_UNREAD_PARAM) === BOARD_UNREAD_ON
  // `undefined` means the IDB row hasn't hydrated yet — distinct from a
  // hydrated-but-empty `unreadCounts`. Conflating the two would fail CLOSED on
  // a cold `?unread=true` load (every already-fetched post filtered out, empty
  // state flashed) before the real counts arrive a beat later.
  const unreadState = useWorkspaceUnreadState(workspaceId)
  // Mute-aware: a muted stream reads as "quiet" and must not resurface via the
  // unread filter, the same rule the sidebar's Unread section follows.
  const mutedStreamIds = useBoardMutedStreamIds(workspaceId)
  const unreadStreamIds = useMemo(() => {
    // Fail OPEN while unhydrated (mirrors matchesTypeScope's pre-field-row
    // fail-open) — the board surfaces the not-yet-filtered feed rather than a
    // false "caught up" empty state.
    if (!unreadOnly || !unreadState) return null
    const ids = new Set<string>()
    for (const [streamId, count] of Object.entries(unreadState.unreadCounts)) {
      if (count > 0 && !mutedStreamIds.has(streamId)) ids.add(streamId)
    }
    return ids
  }, [unreadOnly, unreadState, mutedStreamIds])
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
      unread: unreadStreamIds ? { key: BOARD_UNREAD_ON, streamIds: unreadStreamIds } : null,
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
      unreadStreamIds,
      showArchived,
    ]
  )
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
    handleResizeMove,
    handleResizeEnd,
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
  const exclusions = useMemo(
    () => ({ hidden, muted, muteActive: scopeStreamIds.length === 0 }),
    [hidden, muted, scopeStreamIds.length]
  )
  const {
    posts,
    activityById,
    newCount,
    commit,
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
  const conversationGraph = useConversationGraph(workspaceId)
  const structuralIndex = useStreamStructuralIndex(workspaceId)
  const prewarmStreamIds = useMemo(() => {
    const set = new Set<string>()
    for (const post of posts.slice(0, REVEAL_PREWARM_CARDS)) {
      set.add(post.conversation.streamId)
      for (const id of post.streamIds ?? []) set.add(id)
      // The nested branches the card will render, from the graph itself — the
      // same walk the card does. `post.streamIds` carries a branch's thread
      // stream only when the branch conversation sits in the same filtered feed
      // page (the suppression fold); a branch outside the feed window still
      // renders nested, and without its rail warmed here the branch paints
      // collapsed ("N more replies") and expands a frame later.
      for (const id of collectBranchThreadStreamIds({
        conversationId: post.conversation.id,
        memberMessageIds: post.conversation.messageIds,
        index: structuralIndex,
        graph: conversationGraph,
      })) {
        set.add(id)
      }
    }
    return [...set].sort()
  }, [posts, structuralIndex, conversationGraph])
  const railsReady = useBoardRailsReady(prewarmStreamIds)
  const graphReady = useConversationGraphReady(workspaceId)
  // Draft pills (card reply button, branch tails, sub-topic indicators) read the
  // shared board-drafts snapshot; hold the reveal until its first read lands so
  // a pill is in the card's first frame, never a later one.
  const draftsReady = useBoardDraftsReady(workspaceId)
  // Latch the reveal so a newly added conversation's cold rail can't un-paint the
  // whole feed (see `useBoardRevealLatch`); the gate only holds the first paint.
  const revealReady = useBoardRevealLatch(railsReady && graphReady && draftsReady, workspaceId)
  const holding = posts.length > 0 && !revealReady
  const loading = isLoading || viewLoading || seedPending || holding
  // The shared coordinated-loading machine (INV-35), not a second copy of its
  // timer: blank while the feed load is young, skeleton only once it is
  // genuinely slow. The board's readiness is derived rather than latched, so a
  // later filter change earns its own skeleton.
  const skeletonVisible = useCoordinatedPhase({ isLoading: loading, isReady: !loading }) === "skeleton"
  const streams = useWorkspaceStreams(workspaceId)
  const users = useWorkspaceUsers(workspaceId)
  const dmPeers = useWorkspaceDmPeers(workspaceId)
  const streamById = useMemo(() => new Map(streams.map((s) => [s.id, s])), [streams])
  // Peer user id per DM stream — feeds the card's leading avatar (sidebar parity).
  const dmPeerByStreamId = useMemo(() => new Map(dmPeers.map((p) => [p.streamId, p.userId])), [dmPeers])
  const sections = useMemo(() => groupByRecency(posts, activityById, Date.now()), [posts, activityById])

  // The board feed is virtualized (`virtua`): ~430 active cards each mount
  // multiple ref-counted liveQueries + observers, so windowing to the visible
  // set is the perf floor. We own the scroller (a plain overflow div) and hand
  // its ref to the Virtualizer via `scrollRef`, exactly like the timeline —
  // virtua then maintains scroll position across item measurement and above-fold
  // reflow, which is what the hand-rolled `useBoardScrollAnchor` used to do.
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const listRef = useRef<VirtualizerHandle | null>(null)
  const registerScroller = useCallback((node: HTMLDivElement | null) => {
    scrollerRef.current = node
  }, [])

  // The composer sits above the virtualized rows inside the same scroller, so
  // virtua must know how much space it occupies (`startMargin`) or its item
  // offsets are off by the composer's height. Measured live — the composer grows
  // when opened/typed — via a ResizeObserver on its wrapper. A callback ref into
  // state (not a plain ref + mount-once effect) re-attaches the observer when the
  // wrapper node changes: on mobile, opening a conversation panel unmounts the
  // whole board column and closing it mounts a fresh composer node, and a
  // mount-once effect would leave the observer bound to the dead node — freezing
  // `startMargin` so virtua's offsets drift once the new composer resizes.
  const [composerEl, setComposerEl] = useState<HTMLDivElement | null>(null)
  const [startMargin, setStartMargin] = useState(0)
  useLayoutEffect(() => {
    if (!composerEl) return
    const measure = () => setStartMargin(composerEl.offsetHeight)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(composerEl)
    return () => observer.disconnect()
  }, [composerEl])

  // Changing lens OR scope replaces the feed with a different (often much
  // shorter) subset, so jump to the top pre-paint — otherwise a viewer scrolled
  // down the All wall who taps Decisions lands past the end of a one-card list.
  const resetKey = `${lens}|${scopeKey}|${typeKey}|${excludeScopeKey}|${excludeTypeKey}|${labelKey}|${excludeLabelKey}|${showArchived ? "arch" : ""}|${unreadOnly ? "unread" : ""}`
  useLayoutEffect(() => {
    if (scrollerRef.current) scrollerRef.current.scrollTop = 0
  }, [resetKey])

  const revealNew = () => {
    // Jump to the top first so the freshly-committed cards flow in where the
    // viewer can see them, then commit the buffered order.
    if (scrollerRef.current) scrollerRef.current.scrollTop = 0
    commit()
  }

  const navigate = useNavigate()
  // "Show everything" / the own-post-must-surface baseline is **All**, not the
  // viewer's home: a fresh post is no Decision (and needn't be Active), so only
  // the widest lens guarantees the author's own card appears (design § "your own
  // action always surfaces"). Explicit `?lens=all` — never the bare entry alias —
  // with the non-filter query state (an open `?panel=`) riding along.
  const boardEverything = {
    pathname: `/w/${workspaceId}/board`,
    search: clearFiltersSearch(searchParams.toString()),
  }
  const hasFilterParams =
    scopeStreamIds.length > 0 ||
    scopeStreamTypes.length > 0 ||
    excludeStreamIds.length > 0 ||
    excludeStreamTypes.length > 0 ||
    scopeLabelIds.length > 0 ||
    excludeLabelIds.length > 0 ||
    unreadOnly
  // The viewer's own just-posted card gets a brief gold-thread flash (the golden
  // thread motif, on the primary action). The flashed id lives in a module store
  // (`setBoardFlash`) that each card subscribes to by its own id, not in page
  // state — routing it through `renderedRows` would rebuild every mounted card
  // twice per post (set + clear). Held ~1.6s so the ~1.4s pulse finishes.
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      clearTimeout(flashTimerRef.current ?? undefined)
      setBoardFlash(null)
    },
    []
  )

  const handlePosted = (conversationId?: string) => {
    // The viewer's own post must ALWAYS surface. It already shows where the
    // current view can contain it — an unfiltered `all`/`mine` lens — so stay
    // put there (a `mine` home shouldn't bounce the author off their own home),
    // but jump to the top so the prepended card and its flash are on-screen even
    // if the viewer had scrolled down. Any other view (a status/memo lens, or an
    // active scope filter) might not match the fresh post, so return to the All
    // baseline; the optimistic card (written `_status: "pending"`) reveals itself
    // at top there via `reconcileStableView`, and `navigate` scrolls to top via
    // the `resetKey` layout effect.
    const currentViewSurfacesOwnPost = SELF_POST_VISIBLE_LENSES.has(lens) && !hasFilterParams
    if (currentViewSurfacesOwnPost) {
      if (scrollerRef.current) scrollerRef.current.scrollTop = 0
    } else {
      navigate(boardEverything)
    }
    if (conversationId) {
      setBoardFlash(conversationId)
      clearTimeout(flashTimerRef.current ?? undefined)
      flashTimerRef.current = setTimeout(() => setBoardFlash(null), 1600)
    }
  }

  // Register the board's post-reveal with the single app-level compose overlay so
  // a post surfaces here whichever entry point opened it (board button, command)
  // — while the board is mounted. A stable wrapper reads the latest handler via a
  // ref so it re-registers once, not every render.
  const handlePostedRef = useRef(handlePosted)
  handlePostedRef.current = handlePosted
  useEffect(() => registerComposeOnPosted((conversationId) => handlePostedRef.current(conversationId)), [])

  // Where the post lives — the stream's own name (channel #slug, DM peer,
  // scratchpad name), used as the card's locator. The glyph follows the type.
  // Stable per workspace-cache change so the row memo below only recomputes when a
  // label input actually changes, not on every parent re-render.
  const labelsFor = useCallback(
    (
      conversation: ConversationWithStaleness
    ): { contextLabel: string; streamType: string | undefined; dmPeerUserId: string | null } => {
      const streamName = resolveStreamName(conversation.streamId, { streams, users, dmPeers }, "generic")
      return {
        contextLabel: streamName ?? "Unknown stream",
        streamType: streamById.get(conversation.streamId)?.type,
        dmPeerUserId: dmPeerByStreamId.get(conversation.streamId) ?? null,
      }
    },
    [streams, users, dmPeers, streamById, dmPeerByStreamId]
  )

  // Flat if-chain, not a nested ternary (INV-47 / no-nested-ternary).
  let loadMoreLabel = "Load more"
  if (isFetchingNextPage) loadMoreLabel = "Loading…"
  else if (isFetchNextPageError) loadMoreLabel = "Retry"

  // Prefer cached/live content: a transient refetch error never hides a feed we
  // already have. Cards render only once the reveal gate clears (rails + graph
  // resolved) so the first paint is complete; the skeleton earns its slot only
  // past SKELETON_DELAY_MS of genuine loading (cold device), never as a flash on
  // a warm refresh. Empty state only once IDB has resolved to genuinely nothing.
  const showFeed = posts.length > 0 && revealReady

  // The virtualized feed is ONE flat row list — recency-section headers
  // interleaved with their cards, plus a trailing load-more — so the whole board
  // is a single <Virtualizer> instead of one per section (a section can hold
  // hundreds of cards, so per-section virtualization would defeat the purpose).
  // Inter-card spacing and section separation live on the rows themselves (a
  // flat list has no per-section flex-gap to lean on).
  type FeedRow =
    | { kind: "header"; key: string; label: string; first: boolean }
    | { kind: "card"; key: string; post: BoardViewPost }
    | { kind: "load-more"; key: string }
  const feedRows = useMemo<FeedRow[]>(() => {
    if (!showFeed) return []
    const rows: FeedRow[] = []
    sections.forEach((section, i) => {
      rows.push({ kind: "header", key: `h:${section.label}`, label: section.label, first: i === 0 })
      for (const post of section.posts) rows.push({ kind: "card", key: post.conversation.id, post })
    })
    if (hasNextPage) rows.push({ kind: "load-more", key: "load-more" })
    return rows
  }, [showFeed, sections, hasNextPage])

  // Render the flat rows to elements ONCE per real change and hand virtua a stable
  // array. Deliberately excludes `startMargin`: the composer's ResizeObserver bumps
  // it on every line-wrap while typing a post, and without this memo that would
  // rebuild all ~430 elements (each `labelsFor` + a fresh <BoardCard>) and re-render
  // every mounted card on the exact page this PR de-janks. virtua only mounts the
  // visible slice, but the element array is built in full regardless.
  const renderedRows = useMemo<ReactNode[]>(
    () =>
      feedRows.map((row) => {
        if (row.kind === "header") {
          return (
            <h2
              key={row.key}
              className={cn(
                "flex items-center gap-3 px-1 pb-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground",
                row.first ? "pt-2" : "pt-6"
              )}
            >
              <span className="shrink-0">{row.label}</span>
              <span className="h-px flex-1 bg-border" aria-hidden />
            </h2>
          )
        }
        if (row.kind === "load-more") {
          return (
            <div key={row.key} className="mt-1 flex flex-col items-center gap-1 pb-3">
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
          )
        }
        const { contextLabel, streamType, dmPeerUserId } = labelsFor(row.post.conversation)
        return (
          <div key={row.key} className="pb-3">
            <BoardCard
              workspaceId={workspaceId}
              post={row.post}
              contextLabel={contextLabel}
              streamType={streamType}
              dmPeerUserId={dmPeerUserId}
              scrollerRef={scrollerRef}
              listRef={listRef}
            />
          </div>
        )
      }),
    [feedRows, labelsFor, isFetchNextPageError, isFetchingNextPage, fetchNextPage, loadMoreLabel, workspaceId]
  )

  // Non-feed states (error / skeleton / empty) render as a single centered block
  // below the composer — nothing to virtualize.
  let stateContent: ReactNode = null
  if (!showFeed) {
    if (isError && posts.length === 0) {
      // A failed fetch must read as a failure, not as the empty state's upbeat
      // copy — but cached content mid-reveal still outranks it (the hold above
      // resolves in one IDB round-trip; erroring over a full cache would flash).
      stateContent = (
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
      stateContent = skeletonVisible ? (
        <div className="flex flex-col gap-3 pt-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <BoardCardSkeleton key={i} />
          ))}
        </div>
      ) : null
    } else {
      // A filtered-empty view is the FILTERS coming up empty, never the board
      // hiding things — so it always offers the one-tap way back to everything.
      // Filtered is absolute (narrower than the unfiltered All lens), so even a
      // saved-view or non-All home's own empty landing offers the escape.
      const scoped = hasFilterParams
      const isFiltered =
        isBoardFiltered({
          lens,
          scopeStreamIds,
          scopeStreamTypes,
          scopeLabelIds,
          excludeStreamIds,
          excludeStreamTypes,
          excludeLabelIds,
        }) || unreadOnly
      const copy = scoped ? SCOPED_EMPTY_COPY : LENS_EMPTY_COPY[lens]
      stateContent = (
        <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
          {/* The board's own emblem in a warm gold tile — deliberately NOT the
              FAB's PenLine: a same-size gold `PenLine` square reads as the compose
              button, and the FAB is on screen at once, so a decorative copy would
              invite a dead tap. Warmth comes from the tile, not a fake control. */}
          <div className="flex size-14 items-center justify-center rounded-2xl bg-primary/10 text-primary dark:bg-primary/15">
            <LayoutGrid className="h-6 w-6" />
          </div>
          <p className="text-sm font-medium">{copy.title}</p>
          <p className="max-w-sm text-sm text-muted-foreground">{copy.body}</p>
          {isFiltered && (
            <Link to={boardEverything} className={cn(buttonVariants({ variant: "outline" }), "mt-1 min-h-11")}>
              Show everything
            </Link>
          )}
        </div>
      )
    }
  }

  // Anchor for the mobile floating reply composer: an open card composer portals
  // into this positioned container (pinned above the keyboard) instead of
  // expanding in place mid-feed. Desktop composers ignore it.
  const [floatingAnchorEl, setFloatingAnchorEl] = useState<HTMLElement | null>(null)

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
      <span className="sr-only" role="status" aria-live="polite">
        {newCount > 0 ? `${newCount} new ${newCount === 1 ? "post" : "posts"} available` : ""}
      </span>
      {/* The "N new" pill floats over the top of the feed (see BoardNewPostsPill),
          so buffered posts never shove the composer/feed down the way the old
          in-flow banner did. Anchored to the viewport top (fixed `top-2`), not the
          composer's height, so a mobile-expanded composer can't clip it. */}
      <div ref={setFloatingAnchorEl} className="relative flex-1 overflow-hidden">
        {newCount > 0 && <BoardNewPostsPill count={newCount} onReveal={revealNew} scrollerRef={scrollerRef} />}
        {/* Owned scroller (a plain overflow div, like the timeline): virtua drives
            it via `scrollRef`, so scroll decisions read native metrics with no
            library tug-of-war. `overflowAnchor: none` keeps the browser's own
            scroll anchoring from fighting virtua. `data-board-scroll-viewport` is
            the IntersectionObserver root the cards' sticky-header sentinel reads. */}
        <FloatingComposerAnchorProvider el={floatingAnchorEl}>
          <div
            ref={registerScroller}
            data-board-scroll-viewport
            className="h-full overflow-y-auto overflow-x-hidden overscroll-y-contain"
            style={{ overflowAnchor: "none" }}
          >
            <main
              className="mx-auto w-full max-w-[800px] px-2 sm:px-4"
              // Reserve space under the feed while a mobile floating composer is
              // open, so the reply target can scroll above the pill; 0 otherwise.
              style={{ paddingBottom: `var(${FLOATING_COMPOSER_HEIGHT_VAR}, 0px)` }}
            >
              {/* Small top inset above the virtualized rows; its measured height
                  feeds virtua's `startMargin` so item offsets stay aligned.
                  Authoring lifts into the overlay, opened from the floating compose
                  button below rather than an inline top trigger. */}
              <div ref={setComposerEl} className="pt-3" />
              {showFeed ? (
                <BoardFeedList scrollRef={scrollerRef} listRef={listRef} startMargin={startMargin}>
                  {renderedRows}
                </BoardFeedList>
              ) : (
                stateContent
              )}
            </main>
          </div>
        </FloatingComposerAnchorProvider>
        {/* Floating compose button — always reachable (doesn't scroll with the
            feed), bottom-right. Flat solid accent + a restrained warm shadow, per
            Threa's Button language (no gradient/gloss). On a pointer it expands to
            reveal its "New post" label. Opens the same overlay as the command. */}
        <button
          type="button"
          onClick={() => openCompose()}
          aria-label="New post"
          className={cn(
            "group absolute bottom-[max(1.25rem,env(safe-area-inset-bottom))] right-5 z-20",
            // Width is content-driven (min-w square when collapsed), so the
            // expanded pill hugs its label + icon with no slack — the icon stays
            // pinned right and the label slides in to its left.
            "flex h-14 min-w-[56px] items-center justify-end overflow-hidden rounded-2xl pl-0 pr-[18px]",
            "transition-[padding,gap,background-color] duration-200 ease-out",
            "sm:hover:gap-2 sm:hover:pl-[18px]",
            "bg-primary text-primary-foreground hover:bg-primary/90",
            "shadow-[0_6px_16px_-6px_hsl(28_30%_22%/0.3),0_2px_5px_-2px_hsl(28_30%_22%/0.14)]",
            "dark:shadow-[0_8px_20px_-8px_rgb(0_0_0/0.5),0_2px_6px_-2px_rgb(0_0_0/0.3)]"
          )}
        >
          <span className="hidden max-w-0 whitespace-nowrap text-[13px] font-medium opacity-0 transition-[max-width,opacity] duration-200 group-hover:max-w-[96px] group-hover:opacity-100 sm:block">
            New post
          </span>
          <PenLine className="h-5 w-5 shrink-0" />
        </button>
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
        onResizeMove={handleResizeMove}
        onResizeEnd={handleResizeEnd}
        onResizeKeyDown={handleResizeKeyDown}
      >
        <PanelHost workspaceId={workspaceId} onClose={closePanel} />
      </ThreadPanelSlot>
    </div>
  )
}
