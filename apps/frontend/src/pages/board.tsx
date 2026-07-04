import { useEffect, useMemo, useRef, useState } from "react"
import { AlertCircle, ArrowUp, LayoutGrid } from "lucide-react"
import { Navigate, useParams } from "react-router-dom"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Skeleton } from "@/components/ui/skeleton"
import { PageHeaderTabs, ThreadPanelSlot } from "@/components/layout"
import { PanelHost } from "@/components/layout/panel-host"
import { usePanel, useSidebar } from "@/contexts"
import { usePanelLayout } from "@/hooks"
import { useFeatureFlagWhenKnown } from "@/hooks/use-feature-flags"
import { resolveStreamName } from "@/lib/streams"
import { localStartOfDayMs } from "@/lib/dates"
import { useWorkspaceStreams, useWorkspaceUsers, useWorkspaceDmPeers } from "@/stores/workspace-store"
import { useStableBoardView, type BoardViewPost } from "@/hooks/use-stable-board-view"
import { useBoardStreamSubscriptions } from "@/hooks/use-board-stream-subscriptions"
import { BOARD_CARD_ATTR, useBoardScrollAnchor } from "@/hooks/use-board-scroll-anchor"
import { useWorkspaceConversations } from "@/hooks/use-conversations"
import { BoardCard } from "@/components/board/board-card"
import { BoardComposer } from "@/components/board/board-composer"
import { BOARD_LENSES, type BoardLens, type ConversationWithStaleness } from "@threa/types"

/** The structural lenses as tab chips — order and labels for the board header. */
const LENS_TABS: { value: BoardLens; label: string }[] = [
  { value: "active", label: "Active" },
  { value: "needs-resolution", label: "Needs resolution" },
  { value: "decisions", label: "Decisions" },
]

const VALID_LENSES = new Set<string>(BOARD_LENSES)

/** Empty-state copy per lens — an empty Decisions view isn't "nothing on the board". */
const LENS_EMPTY_COPY: Record<BoardLens, { title: string; body: string }> = {
  active: {
    title: "Nothing on the board yet",
    body: "As your conversations build up, the topics worth returning to surface here, newest activity first.",
  },
  "needs-resolution": {
    title: "No loose ends",
    body: "Conversations that stall or go quiet while unresolved show up here. Nothing needs picking back up right now.",
  },
  decisions: {
    title: "No decisions captured yet",
    body: "When a conversation produces a memo — a decision, a fact worth keeping — it surfaces here as settled knowledge.",
  },
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
 * Route is `/w/:workspaceId/board/:lens?` — bare `/board` is the default Active
 * lens; `/board/needs-resolution`, `/board/decisions` render the structural
 * lenses (board-view-design.md § "Lenses"). Refreshes, back/forward, and shared
 * links land on the same lens (INV-59). `active` canonicalises to the unsegmented
 * URL so there aren't two URLs for the default; an unknown segment redirects to it.
 */
export function BoardPage() {
  const { workspaceId, lens: lensParam } = useParams<{ workspaceId: string; lens?: string }>()
  if (!workspaceId) return null
  if (lensParam === "active") return <Navigate to={`/w/${workspaceId}/board`} replace />
  if (lensParam !== undefined && !VALID_LENSES.has(lensParam)) {
    return <Navigate to={`/w/${workspaceId}/board`} replace />
  }
  const lens: BoardLens = (lensParam as BoardLens | undefined) ?? "active"
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
    useWorkspaceConversations(workspaceId, { lens, limit: 50 })
  const {
    posts,
    activityById,
    newCount,
    commit,
    revealNext,
    isLoading: viewLoading,
  } = useStableBoardView(workspaceId, lens)
  // After a refetch settles, `isLoading` is already false but the seed effect
  // writes IDB on the next tick, so the IDB feed can be momentarily empty while
  // the query already holds posts. Treat that window as loading so the feed
  // doesn't flash the empty state before the seed lands.
  const seedPending = (data?.pages.some((page) => page.posts.length > 0) ?? false) && posts.length === 0
  // Keep the streams behind on-screen cards live + offline-first (threads and
  // public channels the viewer never joined aren't subscribed at bootstrap).
  useBoardStreamSubscriptions(posts)
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
  useBoardScrollAnchor(viewport)

  const revealNew = () => {
    // Jump to the top first so the freshly-committed cards flow in where the
    // viewer can see them; the anchor stays out of the way near the top.
    if (viewport) viewport.scrollTop = 0
    commit()
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
  // already have. Skeleton only before the first IDB read resolves AND nothing
  // is cached; empty state only once IDB has resolved to genuinely nothing.
  let content
  if (posts.length > 0) {
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
  } else if (isError) {
    // A failed fetch must read as a failure, not as the empty state's upbeat copy.
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
  } else if (isLoading || viewLoading || seedPending) {
    content = (
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
    )
  } else {
    content = (
      <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center">
        <LayoutGrid className="h-8 w-8 text-muted-foreground" />
        <p className="text-sm font-medium">{LENS_EMPTY_COPY[lens].title}</p>
        <p className="max-w-sm text-sm text-muted-foreground">{LENS_EMPTY_COPY[lens].body}</p>
      </div>
    )
  }

  const boardColumn = (
    <div className="flex h-full flex-col">
      <PageHeaderTabs
        backTo={`/w/${workspaceId}`}
        icon={LayoutGrid}
        title="Board"
        value={lens}
        tabs={LENS_TABS.map((t) => ({
          value: t.value,
          label: t.label,
          href: t.value === "active" ? `/w/${workspaceId}/board` : `/w/${workspaceId}/board/${t.value}`,
        }))}
      />
      <span className="sr-only" role="status" aria-live="polite">
        {newCount > 0 ? `${newCount} new ${newCount === 1 ? "post" : "posts"} available` : ""}
      </span>
      <div className="relative flex-1 overflow-hidden">
        <ScrollArea ref={scrollRootRef} className="h-full [&>div>div]:!block [&>div>div]:!w-full">
          <main className="mx-auto w-full max-w-[800px] px-2 py-3 sm:px-4">
            <BoardComposer workspaceId={workspaceId} onPosted={revealNext} />
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
