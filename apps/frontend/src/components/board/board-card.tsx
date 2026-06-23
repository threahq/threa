import { useState } from "react"
import { Link } from "react-router-dom"
import { useQuery } from "@tanstack/react-query"
import { Hash, FileEdit, User, MessageSquareText, ChevronDown, type LucideIcon } from "lucide-react"
import { ActorAvatar } from "@/components/actor-avatar"
import { RelativeTime } from "@/components/relative-time"
import { MarkdownContent } from "@/components/ui/markdown-content"
import { MessageReactions } from "@/components/timeline/message-reactions"
import { useActors } from "@/hooks"
import { useWorkspaceUserId } from "@/hooks/use-workspaces"
import { useConversationService } from "@/contexts"
import { conversationKeys } from "@/hooks/use-conversations"
import type { AuthorType, BoardPost } from "@threa/types"

interface BoardCardProps {
  workspaceId: string
  post: BoardPost
  /** Topic of the grouping, resolved by the page (scratchpad name / channel topic). */
  topic: string
  /** Where the post lives (channel name, DM peer, "Scratchpad"), for the header. */
  contextLabel: string
  /** Resolved stream type, selecting the context glyph. */
  streamType: string | undefined
}

const TYPE_GLYPH: Record<string, LucideIcon> = {
  channel: Hash,
  scratchpad: FileEdit,
  dm: User,
}

/** The fields the post renderer reads — satisfied by both `BoardPostMessage`
 * (feed payload) and a full `Message` (fetched on expand). */
interface RenderableMessage {
  id: string
  authorId: string
  authorType: AuthorType
  contentMarkdown: string
  reactions: Record<string, string[]>
  createdAt: string | Date
}

/**
 * One board post: a conversation rendered as a feed post. The opening message is
 * the body, the latest replies stack beneath it, and a collapsed "N more
 * messages" gap fills in on click. Messages render through the same primitives as
 * the timeline (`ActorAvatar`, `MarkdownContent`, `MessageReactions`) so a board
 * message reads exactly like a real message. The card itself delimits the
 * conversation, so replies aren't indented. The conversation is context (header),
 * not the unit.
 */
export function BoardCard({ workspaceId, post, topic, contextLabel, streamType }: BoardCardProps) {
  const { conversation, openingMessage, recentMessages } = post
  const { getActorName } = useActors(workspaceId)
  const currentUserId = useWorkspaceUserId(workspaceId)
  const conversationService = useConversationService()
  const [expanded, setExpanded] = useState(false)

  const streamId = conversation.streamId
  const messageCount = conversation.messageIds.length
  const hiddenCount = Math.max(0, messageCount - (openingMessage ? 1 : 0) - recentMessages.length)
  const ContextGlyph = (streamType && TYPE_GLYPH[streamType]) || MessageSquareText

  const {
    data: allMessages,
    isError: expandFailed,
    refetch: refetchMessages,
  } = useQuery({
    queryKey: conversationKeys.messages(conversation.id),
    queryFn: () => conversationService.getMessages(workspaceId, conversation.id),
    enabled: expanded,
    staleTime: 60_000,
  })

  // Expanded: the full conversation minus the opening (which renders above).
  // Collapsed: just the trailing replies the feed already carried.
  const replies: RenderableMessage[] =
    expanded && allMessages ? allMessages.filter((m) => m.id !== openingMessage?.id) : recentMessages
  const loadingMore = expanded && !allMessages && !expandFailed

  return (
    <div className="rounded-xl border bg-card p-3 sm:p-4">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <ContextGlyph className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{contextLabel}</span>
        {topic && (
          <>
            <span aria-hidden>·</span>
            <span className="truncate">{topic}</span>
          </>
        )}
        <RelativeTime date={conversation.lastActivityAt} terse className="ml-auto shrink-0" />
      </div>

      <div className="mt-3 flex flex-col gap-3">
        {openingMessage && (
          <PostMessage
            workspaceId={workspaceId}
            streamId={streamId}
            message={openingMessage}
            authorName={getActorName(openingMessage.authorId, openingMessage.authorType)}
            currentUserId={currentUserId}
            emphasis
          />
        )}

        {!expanded && hiddenCount > 0 && (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="flex w-fit items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            <ChevronDown className="h-3.5 w-3.5" />
            {hiddenCount} more {hiddenCount === 1 ? "message" : "messages"}
          </button>
        )}
        {loadingMore && <span className="text-xs text-muted-foreground">Loading messages…</span>}
        {expanded && expandFailed && (
          <button
            type="button"
            onClick={() => void refetchMessages()}
            className="w-fit text-xs text-destructive underline underline-offset-2"
          >
            Couldn't load messages. Retry.
          </button>
        )}

        {replies.map((message) => (
          <PostMessage
            key={message.id}
            workspaceId={workspaceId}
            streamId={streamId}
            message={message}
            authorName={getActorName(message.authorId, message.authorType)}
            currentUserId={currentUserId}
          />
        ))}
      </div>
    </div>
  )
}

interface PostMessageProps {
  workspaceId: string
  streamId: string
  message: RenderableMessage
  authorName: string
  currentUserId: string | null
  /** The opening post — a slightly larger avatar than a reply. */
  emphasis?: boolean
}

function PostMessage({ workspaceId, streamId, message, authorName, currentUserId, emphasis }: PostMessageProps) {
  const hasReactions = Object.keys(message.reactions).length > 0

  return (
    <div className="flex items-start gap-2 sm:gap-3">
      <ActorAvatar
        actorId={message.authorId}
        actorType={message.authorType}
        workspaceId={workspaceId}
        size={emphasis ? "md" : "sm"}
        alt={authorName}
        showStatus={false}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="truncate text-sm font-semibold">{authorName}</span>
          {/* Permalink to the message in its stream timeline — the one navigation
              affordance, so the interactive message body isn't wrapped in a link. */}
          <Link
            to={`/w/${workspaceId}/s/${streamId}?m=${message.id}`}
            className="shrink-0 text-xs text-muted-foreground hover:underline"
          >
            <RelativeTime date={message.createdAt} terse />
          </Link>
        </div>
        <MarkdownContent content={message.contentMarkdown} messageId={message.id} className="text-sm leading-relaxed" />
        {hasReactions && (
          <MessageReactions
            reactions={message.reactions}
            workspaceId={workspaceId}
            messageId={message.id}
            currentUserId={currentUserId}
          />
        )}
      </div>
    </div>
  )
}
