import { useMemo } from "react"
import { AlertCircle, LayoutGrid } from "lucide-react"
import { Navigate, useParams } from "react-router-dom"
import { StreamTypes } from "@threa/types"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Skeleton } from "@/components/ui/skeleton"
import { PageHeaderTabs } from "@/components/layout"
import { useFeatureFlagWhenKnown } from "@/hooks/use-feature-flags"
import { resolveStreamName } from "@/lib/streams"
import { localStartOfDayMs } from "@/lib/dates"
import { useWorkspaceStreams, useWorkspaceUsers, useWorkspaceDmPeers } from "@/stores/workspace-store"
import { useWorkspaceConversations } from "@/hooks/use-conversations"
import { BoardCard } from "@/components/board/board-card"
import type { BoardPost, ConversationWithStaleness } from "@threa/types"

/**
 * Coarse recency bucket for a post's last activity, in device-local time
 * (INV-42). The board is ordered by activity desc, so consecutive posts fall into
 * monotonic buckets — grouping them gives the feed structure without disturbing
 * the recency order. Day boundaries, not 24h windows, so "Yesterday" matches the
 * user's calendar.
 */
function recencyBucket(date: Date | string, nowMs: number): string {
  const daysAgo = Math.round((localStartOfDayMs(new Date(nowMs)) - localStartOfDayMs(new Date(date))) / 86_400_000)
  if (daysAgo <= 0) return "Today"
  if (daysAgo === 1) return "Yesterday"
  if (daysAgo <= 6) return "Earlier this week"
  if (daysAgo <= 30) return "This month"
  return "Older"
}

interface BoardSection {
  label: string
  posts: BoardPost[]
}

/** Fold the recency-sorted feed into consecutive buckets, preserving order. */
function groupByRecency(posts: BoardPost[], nowMs: number): BoardSection[] {
  const sections: BoardSection[] = []
  for (const post of posts) {
    const label = recencyBucket(post.conversation.lastActivityAt, nowMs)
    const last = sections[sections.length - 1]
    if (last?.label === label) last.posts.push(post)
    else sections.push({ label, posts: [post] })
  }
  return sections
}

/**
 * The board: a cross-stream feed of posts (each conversation surfaced as a
 * message-led post) ordered by recent activity, grouped into recency sections.
 * Lenses and a scope filter land as tabs here later; for now a single "All" tab
 * shows everything the viewer can read.
 */
export function BoardPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>()
  if (!workspaceId) return null
  return <BoardPageGate workspaceId={workspaceId} />
}

/**
 * The board is gated behind the `board-view` feature flag. While the bootstrap
 * (and thus the flag) is still unknown, render nothing rather than redirect —
 * redirecting on the default would bounce a flagged user who deep-links or
 * refreshes on /board before the bootstrap cache is populated. The backend
 * endpoint 404s without the flag too, so this is the UX half of the gate.
 */
function BoardPageGate({ workspaceId }: { workspaceId: string }) {
  const boardFlag = useFeatureFlagWhenKnown(workspaceId, "board-view")
  if (boardFlag === null) return null
  if (boardFlag !== "on") return <Navigate to={`/w/${workspaceId}`} replace />
  return <BoardPageInner workspaceId={workspaceId} />
}

function BoardPageInner({ workspaceId }: { workspaceId: string }) {
  const { data, isLoading, isError, refetch, fetchNextPage, hasNextPage, isFetchingNextPage, isFetchNextPageError } =
    useWorkspaceConversations(workspaceId, { limit: 50 })
  const posts = useMemo(() => data?.pages.flatMap((page) => page.posts) ?? [], [data])
  const streams = useWorkspaceStreams(workspaceId)
  const users = useWorkspaceUsers(workspaceId)
  const dmPeers = useWorkspaceDmPeers(workspaceId)
  const streamById = useMemo(() => new Map(streams.map((s) => [s.id, s])), [streams])
  const sections = useMemo(() => groupByRecency(posts, Date.now()), [posts])

  // A scratchpad IS its conversation, so its own name is the best topic (the
  // stored "Scratchpad" topicSummary is noise). For channels/DMs the topic is
  // the topicSummary and the stream is context — never the DM peer as the topic,
  // since that name is a person, not a topic.
  function labelsFor(conversation: ConversationWithStaleness): {
    title: string
    contextLabel: string
    streamType: string | undefined
  } {
    const streamName = resolveStreamName(conversation.streamId, { streams, users, dmPeers }, "generic")
    const streamType = streamById.get(conversation.streamId)?.type
    if (streamType === StreamTypes.SCRATCHPAD) {
      return { title: streamName ?? "Scratchpad", contextLabel: "Scratchpad", streamType }
    }
    return {
      // The body carries the content, so an absent topic just omits the subject
      // line rather than showing an "Untitled" placeholder.
      title: conversation.topicSummary?.trim() ?? "",
      contextLabel: streamName ?? "Unknown stream",
      streamType,
    }
  }

  // Flat if-chain, not a nested ternary (INV-47 / no-nested-ternary).
  let loadMoreLabel = "Load more"
  if (isFetchingNextPage) loadMoreLabel = "Loading…"
  else if (isFetchNextPageError) loadMoreLabel = "Retry"

  let content
  if (isLoading) {
    content = (
      <div className="flex flex-col gap-0.5">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="flex items-start gap-3 px-3 py-2.5 sm:px-4 sm:py-3">
            <Skeleton className="h-9 w-9 shrink-0 rounded-[10px]" />
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-3.5 w-2/5" />
              <Skeleton className="h-3 w-3/5" />
            </div>
          </div>
        ))}
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
  } else if (posts.length === 0) {
    content = (
      <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center">
        <LayoutGrid className="h-8 w-8 text-muted-foreground" />
        <p className="text-sm font-medium">Nothing on the board yet</p>
        <p className="max-w-sm text-sm text-muted-foreground">
          As your conversations build up, the topics worth returning to surface here, newest activity first.
        </p>
      </div>
    )
  } else {
    content = (
      <div className="flex flex-col">
        {sections.map((section) => (
          <section key={section.label} className="mb-2">
            <h2 className="px-3 pb-1 pt-3 text-xs font-medium uppercase tracking-wider text-muted-foreground sm:px-4">
              {section.label}
            </h2>
            <div className="flex flex-col gap-1">
              {section.posts.map((post) => {
                const { title, contextLabel, streamType } = labelsFor(post.conversation)
                return (
                  <BoardCard
                    key={post.conversation.id}
                    workspaceId={workspaceId}
                    post={post}
                    topic={title}
                    contextLabel={contextLabel}
                    streamType={streamType}
                  />
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
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeaderTabs
        backTo={`/w/${workspaceId}`}
        icon={LayoutGrid}
        title="Board"
        value="all"
        tabs={[{ value: "all", label: "All", href: `/w/${workspaceId}/board` }]}
      />
      <ScrollArea className="flex-1 [&>div>div]:!block [&>div>div]:!w-full">
        <main className="py-2">{content}</main>
      </ScrollArea>
    </div>
  )
}
