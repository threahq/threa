import { useMemo } from "react"
import { AlertCircle, LayoutGrid } from "lucide-react"
import { useParams } from "react-router-dom"
import { StreamTypes } from "@threa/types"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Skeleton } from "@/components/ui/skeleton"
import { PageHeaderTabs } from "@/components/layout"
import { resolveStreamName } from "@/lib/streams"
import { useWorkspaceStreams, useWorkspaceUsers, useWorkspaceDmPeers } from "@/stores/workspace-store"
import { useWorkspaceConversations } from "@/hooks/use-conversations"
import { BoardCard } from "@/components/board/board-card"
import type { ConversationWithStaleness } from "@threa/types"

/**
 * The board: a cross-stream wall of conversations (Threa's topic primitive)
 * ordered by recent activity — the read-only foundation of the board view
 * (slice 1). Lenses and a scope filter land as tabs here later; for now a single
 * "All" tab shows everything the viewer can read.
 */
export function BoardPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>()
  if (!workspaceId) return null
  return <BoardPageInner workspaceId={workspaceId} />
}

function BoardPageInner({ workspaceId }: { workspaceId: string }) {
  const { data, isLoading, isError, refetch, fetchNextPage, hasNextPage, isFetchingNextPage, isFetchNextPageError } =
    useWorkspaceConversations(workspaceId, { limit: 50 })
  const conversations = useMemo(() => data?.pages.flatMap((page) => page.conversations) ?? [], [data])
  const streams = useWorkspaceStreams(workspaceId)
  const users = useWorkspaceUsers(workspaceId)
  const dmPeers = useWorkspaceDmPeers(workspaceId)
  const streamById = useMemo(() => new Map(streams.map((s) => [s.id, s])), [streams])

  // A scratchpad IS its conversation, so its own name is the best title (the
  // stored "Scratchpad" topicSummary is noise). For channels/DMs the topic is
  // the title and the stream is context — never the DM peer as the title, since
  // that name is a person, not a topic.
  function labelsFor(conversation: ConversationWithStaleness): { title: string; contextLabel: string } {
    const streamName = resolveStreamName(conversation.streamId, { streams, users, dmPeers }, "generic")
    if (streamById.get(conversation.streamId)?.type === StreamTypes.SCRATCHPAD) {
      return { title: streamName ?? "Scratchpad", contextLabel: "Scratchpad" }
    }
    return {
      title: conversation.topicSummary?.trim() || "Untitled conversation",
      contextLabel: streamName ?? "Unknown stream",
    }
  }

  // Flat if-chain, not a nested ternary (INV-47 / no-nested-ternary).
  let loadMoreLabel = "Load more"
  if (isFetchingNextPage) loadMoreLabel = "Loading…"
  else if (isFetchNextPageError) loadMoreLabel = "Retry"

  let content
  if (isLoading) {
    content = (
      <div className="flex flex-col gap-2 px-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-20 w-full rounded-lg" />
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
  } else if (conversations.length === 0) {
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
      <div className="flex flex-col gap-2 px-3">
        {conversations.map((conversation) => {
          const { title, contextLabel } = labelsFor(conversation)
          return (
            <BoardCard
              key={conversation.id}
              workspaceId={workspaceId}
              conversation={conversation}
              title={title}
              contextLabel={contextLabel}
            />
          )
        })}
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
