import { useState } from "react"
import { Link } from "react-router-dom"
import { useQuery } from "@tanstack/react-query"
import { Hash, FileEdit, User, MessageSquareText, ChevronDown, type LucideIcon } from "lucide-react"
import { RelativeTime } from "@/components/relative-time"
import { MessageItem, isContinuation, type RenderableMessage } from "@/components/message/message-item"
import { BoardReplyComposer } from "@/components/board/board-reply-composer"
import { useActors } from "@/hooks"
import { useWorkspaceUserId } from "@/hooks/use-workspaces"
import { useConversationService } from "@/contexts"
import { conversationKeys } from "@/hooks/use-conversations"
import { useBoardCardMessages, RECENT_PREVIEW_CAP } from "@/hooks/use-board-card-messages"
import type { BoardViewPost } from "@/hooks/use-stable-board-view"

interface BoardCardProps {
  workspaceId: string
  post: BoardViewPost
  /** Where the post lives (channel name, DM peer, scratchpad name), for the header. */
  contextLabel: string
  /** Resolved stream type, selecting the context glyph. */
  streamType: string | undefined
}

const TYPE_GLYPH: Record<string, LucideIcon> = {
  channel: Hash,
  scratchpad: FileEdit,
  dm: User,
}

/**
 * One board post: a conversation rendered as a feed post that reads like the
 * stream timeline. Messages use the same primitives (`ActorAvatar`,
 * `MarkdownContent`, `MessageReactions`) and the same same-author grouping, so a
 * board message is indistinguishable from a real one. The card delimits the
 * conversation (no reply indentation); a collapsed "N more messages" gap fills
 * in on click. The stream it lives in is the header locator, not a topic line.
 */
export function BoardCard({ workspaceId, post, contextLabel, streamType }: BoardCardProps) {
  const { conversation } = post
  const { getActorName } = useActors(workspaceId)
  const currentUserId = useWorkspaceUserId(workspaceId)
  const conversationService = useConversationService()
  const [expanded, setExpanded] = useState(false)
  // Replies sent from this card, shown in place immediately. The events rail
  // carries the authoritative copy once the send round-trips (and any foreign
  // reply), so these are deduped by id against the rail below. A channel reply
  // lands in a thread off the post, so it surfaces as its own post on the next
  // board refresh rather than under this card; that's expected.
  const [localReplies, setLocalReplies] = useState<RenderableMessage[]>([])

  // Bodies ride the same `db.events` rail the timeline does — live and
  // offline-first — with the cached server projection as the cold-start fallback.
  const { openingMessage, replies: railReplies, totalReplies, source } = useBoardCardMessages(post)

  const streamId = conversation.streamId
  const ContextGlyph = (streamType && TYPE_GLYPH[streamType]) || MessageSquareText

  // The rail carries every locally-synced reply; older ones (or a wholly unsynced
  // stream — `source === "projection"`) may be missing, so on expand we backfill
  // the full hydrated set from the server. Never blocks the first render: the
  // local replies show immediately, this only fills the gap when online.
  const incompleteLocally = source === "projection" || railReplies.length < totalReplies
  const {
    data: allMessages,
    isError: expandFailed,
    refetch: refetchMessages,
  } = useQuery({
    queryKey: conversationKeys.boardMessages(conversation.id),
    queryFn: () => conversationService.getBoardMessages(workspaceId, conversation.id),
    enabled: expanded && incompleteLocally,
    staleTime: 60_000,
  })

  // Expanded: the full conversation minus the opening (server backfill when the
  // local rail is incomplete, else the rail itself). Collapsed: the trailing
  // window of the local rail. Flat if-chain, not a nested ternary (INV-47).
  let replies: RenderableMessage[]
  if (!expanded) replies = railReplies.slice(-RECENT_PREVIEW_CAP)
  else if (allMessages) replies = (allMessages as RenderableMessage[]).filter((m) => m.id !== openingMessage?.id)
  else replies = railReplies
  // Append this card's own just-sent replies, skipping any the rail or a backfill
  // already carries.
  const seenReplyIds = new Set(replies.map((m) => m.id))
  const displayedReplies = [...replies, ...localReplies.filter((m) => !seenReplyIds.has(m.id))]
  const hiddenCount = expanded ? 0 : Math.max(0, totalReplies - replies.length)
  const loadingMore = expanded && incompleteLocally && !allMessages && !expandFailed
  // No middle is hidden, so opening + replies form one uninterrupted run that
  // groups across the boundary. Otherwise a gap row sits between them.
  const contiguous = (expanded && (!incompleteLocally || !!allMessages)) || (!expanded && hiddenCount === 0)

  const renderMessage = (message: RenderableMessage, continuation: boolean) => (
    <MessageItem
      key={message.id}
      workspaceId={workspaceId}
      streamId={streamId}
      message={message}
      authorName={getActorName(message.authorId, message.authorType)}
      currentUserId={currentUserId}
      continuation={continuation}
    />
  )

  return (
    <div className="rounded-xl border bg-card p-3 sm:p-4">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {/* The stream the post lives in — a real link back into it (INV-40). */}
        <Link
          to={`/w/${workspaceId}/s/${streamId}`}
          className="flex min-w-0 items-center gap-1.5 transition-colors hover:text-foreground"
        >
          <ContextGlyph className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate font-medium">{contextLabel}</span>
        </Link>
        <RelativeTime date={conversation.lastActivityAt} terse className="ml-auto shrink-0" />
      </div>

      <div className="mt-3 [&>*:first-child]:mt-0">
        {contiguous ? (
          (openingMessage ? [openingMessage, ...displayedReplies] : displayedReplies).map((message, i, all) =>
            renderMessage(message, i > 0 && isContinuation(all[i - 1], message))
          )
        ) : (
          <>
            {openingMessage && renderMessage(openingMessage, false)}
            {!expanded && hiddenCount > 0 && (
              <button
                type="button"
                onClick={() => setExpanded(true)}
                className="mt-3 flex w-fit items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                <ChevronDown className="h-3.5 w-3.5" />
                {hiddenCount} more {hiddenCount === 1 ? "message" : "messages"}
              </button>
            )}
            {loadingMore && <span className="mt-3 block text-xs text-muted-foreground">Loading messages…</span>}
            {expanded && expandFailed && (
              <button
                type="button"
                onClick={() => void refetchMessages()}
                className="mt-3 block w-fit text-xs text-destructive underline underline-offset-2"
              >
                Couldn't load messages. Retry.
              </button>
            )}
            {displayedReplies.map((message, i) =>
              renderMessage(message, i > 0 && isContinuation(displayedReplies[i - 1], message))
            )}
          </>
        )}
      </div>

      <BoardReplyComposer
        workspaceId={workspaceId}
        post={post}
        hostStreamType={streamType}
        onReplied={(message) => setLocalReplies((prev) => [...prev, message])}
      />
    </div>
  )
}
