import { useEffect, useMemo } from "react"
import { useQuery } from "@tanstack/react-query"
import { ChevronLeft, Hash, FileEdit, User, MessageSquareText, type LucideIcon } from "lucide-react"
import {
  SidePanel,
  SidePanelHeader,
  SidePanelTitle,
  SidePanelClose,
  SidePanelContent,
} from "@/components/ui/side-panel"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription } from "@/components/ui/empty"
import { MessageItem, isContinuation, type RenderableMessage } from "@/components/message/message-item"
import { RelativeTime } from "@/components/relative-time"
import { BoardReplyComposer } from "@/components/board/board-reply-composer"
import { SidebarToggle } from "@/components/layout"
import { useActors } from "@/hooks"
import { useWorkspaceUserId } from "@/hooks/use-workspaces"
import { useStreamName } from "@/hooks/use-stream-name"
import { useConversationService, usePanel, parseConversationPanel, useSidebar } from "@/contexts"
import { useStreamFromStore } from "@/stores/stream-store"
import { conversationKeys, useConversationBoardPost } from "@/hooks/use-conversations"
import { useBoardCardMessages } from "@/hooks/use-board-card-messages"
import { usePanelStreamSubscriptions } from "@/hooks/use-panel-stream-subscriptions"
import type { BoardViewPost } from "@/hooks/use-stable-board-view"

const TYPE_GLYPH: Record<string, LucideIcon> = {
  channel: Hash,
  scratchpad: FileEdit,
  dm: User,
}

interface ConversationPanelProps {
  workspaceId: string
  onClose: () => void
}

/**
 * A single conversation opened in the side panel (Mechanism B,
 * board-view-design.md) — a projection peer to a thread, keyed by `?panel=conv:<id>`.
 * Reads the conversation flattened-chronological across its root + threads (one
 * root), live off the same `db.events` rail the board card and timeline ride, and
 * replies scoped to it via the recency-biased board-reply path. No stream is
 * mutated and access is the conversation's single root check (enforced when the
 * by-id post is fetched, INV-62) — the panel adds no per-message gating.
 */
export function ConversationPanel({ workspaceId, onClose }: ConversationPanelProps) {
  const { isMobile } = useSidebar()
  const { panelId } = usePanel()
  const conversationId = panelId ? parseConversationPanel(panelId) : null
  const { post, isLoading, notFound, refetch } = useConversationBoardPost(workspaceId, conversationId)

  // Keep the conversation's streams (root + threads) caught up + joined while the
  // panel is open, so the rail is live and offline-first. Its own SyncEngine slot,
  // so it composes with the board feed rather than clobbering it.
  const panelStreamIds = useMemo(
    () => (post ? [...new Set([post.conversation.streamId, ...(post.streamIds ?? [])])] : []),
    [post]
  )
  usePanelStreamSubscriptions(panelStreamIds)

  // Escape closes the panel, matching StreamPanel — the two are peers in the same
  // slot, so the keyboard affordance should be consistent. Skip when the event was
  // already handled (the reply composer's own Escape collapses the editor first) or
  // when focus is in a text field, so closing the panel never eats a composer Escape.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return
      const active = document.activeElement as HTMLElement | null
      if (active?.closest('[contenteditable="true"], input, textarea')) return
      onClose()
    }
    document.addEventListener("keydown", onKeyDown)
    return () => document.removeEventListener("keydown", onKeyDown)
  }, [onClose])

  const anchorStreamId = post?.conversation.streamId
  const hostStream = useStreamFromStore(anchorStreamId)
  const hostStreamType = hostStream?.type
  const locator = useStreamName(workspaceId, anchorStreamId ?? "", "generic") ?? "Conversation"
  const ContextGlyph = (hostStreamType && TYPE_GLYPH[hostStreamType]) || MessageSquareText

  let body: React.ReactNode
  if (post) {
    body = <ConversationPanelBody workspaceId={workspaceId} post={post} hostStreamType={hostStreamType} />
  } else if (isLoading) {
    body = (
      <div className="flex flex-col gap-3 p-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="flex items-start gap-2">
            <Skeleton className="h-8 w-8 shrink-0 rounded-[8px]" />
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-3.5 w-1/4" />
              <Skeleton className="h-3 w-4/5" />
            </div>
          </div>
        ))}
      </div>
    )
  } else if (notFound) {
    body = (
      <Empty className="min-h-[16rem] border-0">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <MessageSquareText />
          </EmptyMedia>
          <EmptyTitle>Couldn't open this conversation</EmptyTitle>
          {/* The state covers both a transient load failure (retry helps) and a
              gone/merged/access-lost conversation (retry won't) — so the copy names
              both rather than asserting one, keeping "Try again" honest. */}
          <EmptyDescription>
            It may have moved or been merged, you may have lost access, or there was a problem loading it.
          </EmptyDescription>
        </EmptyHeader>
        <Button variant="outline" size="sm" onClick={() => refetch()} className="mt-2">
          Try again
        </Button>
      </Empty>
    )
  } else {
    // Resolved to no post and not an error — transient; show nothing rather than flash.
    body = null
  }

  return (
    <SidePanel data-editor-zone="panel">
      <SidePanelHeader>
        {isMobile && <SidebarToggle location="page" />}
        <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={onClose}>
          <ChevronLeft className="h-4 w-4" />
          <span className="sr-only">Back</span>
        </Button>
        <SidePanelTitle className="flex min-w-0 flex-1 items-center gap-1.5">
          <ContextGlyph className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="truncate">{locator}</span>
          {post && (
            <RelativeTime
              date={post.conversation.lastActivityAt}
              terse
              className="ml-1 shrink-0 text-xs font-normal text-muted-foreground"
            />
          )}
        </SidePanelTitle>
        {!isMobile && <SidePanelClose onClose={onClose} />}
      </SidePanelHeader>
      <SidePanelContent className="flex flex-col">{body}</SidePanelContent>
    </SidePanel>
  )
}

interface ConversationPanelBodyProps {
  workspaceId: string
  post: BoardViewPost
  hostStreamType: string | undefined
}

/**
 * The panel's message column + scoped composer. Always renders the FULL
 * conversation (the panel is permanently "expanded"): the live rail from
 * {@link useBoardCardMessages} for opening + recent + the viewer's pending
 * replies, backfilled with the complete ordered list when the local rail is
 * incomplete — the same merge the board card runs on expand.
 */
function ConversationPanelBody({ workspaceId, post, hostStreamType }: ConversationPanelBodyProps) {
  const { getActorName } = useActors(workspaceId)
  const currentUserId = useWorkspaceUserId(workspaceId)
  const conversationService = useConversationService()
  const { conversation } = post

  const {
    openingMessage,
    replies: railReplies,
    totalReplies,
    pendingReplies,
    source,
  } = useBoardCardMessages(post, hostStreamType)

  // Backfill the full window when the local rail is missing older replies (or the
  // stream isn't synced yet); the live rail shows immediately, this only fills the
  // gap when online. Mirrors board-card's expand path.
  const incompleteLocally = source === "projection" || railReplies.length < totalReplies
  const {
    data: allMessages,
    isError: backfillFailed,
    refetch: refetchMessages,
  } = useQuery({
    queryKey: conversationKeys.boardMessages(conversation.id),
    queryFn: () => conversationService.getBoardMessages(workspaceId, conversation.id),
    enabled: incompleteLocally,
    staleTime: 60_000,
  })

  // Prefer the server backfill only while the local rail is still incomplete; once
  // it catches up, fall through to the rail so live edits keep flowing.
  let replies: RenderableMessage[]
  if (incompleteLocally && allMessages)
    replies = (allMessages as RenderableMessage[]).filter((m) => m.id !== openingMessage?.id)
  else replies = railReplies
  // Merge the viewer's own just-sent replies (deduped), then sort by time — a
  // pending reply can be older than a confirmed one.
  const seenReplyIds = new Set(replies.map((m) => m.id))
  const displayedReplies = [...replies, ...pendingReplies.filter((m) => !seenReplyIds.has(m.id))].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  )
  const loadingMore = incompleteLocally && !allMessages && !backfillFailed

  const all = openingMessage ? [openingMessage, ...displayedReplies] : displayedReplies
  // The conversation's most-recently-active stream — the latest reply's own stream
  // (a thread under the root), so a continuation follows the conversation there
  // instead of re-interleaving the channel (board-view-design.md). Falls back to
  // the conversation's anchor, NOT the opening message's stream (a thread post's
  // opener lives in the parent stream).
  const lastActiveStreamId = displayedReplies.at(-1)?.streamId ?? conversation.streamId

  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 [&>*:first-child]:mt-0">
        {all.map((message, i) => (
          <MessageItem
            key={message.id}
            workspaceId={workspaceId}
            // Each row renders against its own stream so reactions and the
            // permalink target where the message actually lives (one root, many
            // streams); fall back to the anchor.
            streamId={message.streamId ?? conversation.streamId}
            message={message}
            authorName={getActorName(message.authorId, message.authorType)}
            currentUserId={currentUserId}
            continuation={i > 0 && isContinuation(all[i - 1], message)}
          />
        ))}
        {loadingMore && <span className="mt-3 block text-xs text-muted-foreground">Loading messages…</span>}
        {backfillFailed && (
          <button
            type="button"
            onClick={() => void refetchMessages()}
            className="mt-3 block w-fit text-xs text-destructive underline underline-offset-2"
          >
            Couldn't load the full conversation. Retry.
          </button>
        )}
      </div>
      <div className="border-t px-4 py-3">
        <BoardReplyComposer
          workspaceId={workspaceId}
          post={post}
          hostStreamType={hostStreamType}
          lastActiveStreamId={lastActiveStreamId}
        />
      </div>
    </>
  )
}
