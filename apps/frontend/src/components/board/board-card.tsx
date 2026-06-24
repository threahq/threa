import { useState } from "react"
import { Link } from "react-router-dom"
import { useQuery } from "@tanstack/react-query"
import { Hash, FileEdit, User, MessageSquareText, ChevronDown, type LucideIcon } from "lucide-react"
import { ActorAvatar } from "@/components/actor-avatar"
import { RelativeTime } from "@/components/relative-time"
import { MarkdownContent, AttachmentProvider } from "@/components/ui/markdown-content"
import { LinkPreviewProvider } from "@/lib/markdown/link-preview-context"
import { AttachmentList } from "@/components/timeline/attachment-list"
import { LinkPreviewList } from "@/components/timeline/link-preview-list"
import { MemoPreviewList } from "@/components/timeline/memo-preview-list"
import { GiphyPreviewList } from "@/components/timeline/giphy-preview-list"
import { MessageReactions } from "@/components/timeline/message-reactions"
import { useActors } from "@/hooks"
import { useWorkspaceUserId } from "@/hooks/use-workspaces"
import { useUserProfile } from "@/components/user-profile"
import { useFormattedDate } from "@/hooks/use-formatted-date"
import { useConversationService } from "@/contexts"
import { conversationKeys } from "@/hooks/use-conversations"
import type { AttachmentSummary, AuthorType, BoardPost, LinkPreviewSummary } from "@threa/types"

interface BoardCardProps {
  workspaceId: string
  post: BoardPost
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

/** Same-author messages within this window collapse into a continuation (no
 * repeated header) — matches the timeline's grouping. */
const GROUP_WINDOW_MS = 5 * 60_000

/** The fields the post renderer reads — satisfied by both `BoardPostMessage`
 * (feed payload) and a full `Message` (fetched on expand). */
interface RenderableMessage {
  id: string
  authorId: string
  authorType: AuthorType
  contentMarkdown: string
  reactions: Record<string, string[]>
  createdAt: string | Date
  // Present on feed messages (BoardPostMessage); absent on messages fetched via
  // getMessages on expand, which carry no enrichment.
  attachments?: AttachmentSummary[]
  linkPreviews?: LinkPreviewSummary[]
}

function isContinuation(prev: RenderableMessage, cur: RenderableMessage): boolean {
  return (
    prev.authorId === cur.authorId &&
    prev.authorType === cur.authorType &&
    Math.abs(new Date(cur.createdAt).getTime() - new Date(prev.createdAt).getTime()) < GROUP_WINDOW_MS
  )
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
  const { conversation, openingMessage, recentMessages, totalReplies } = post
  const { getActorName } = useActors(workspaceId)
  const currentUserId = useWorkspaceUserId(workspaceId)
  const conversationService = useConversationService()
  const [expanded, setExpanded] = useState(false)

  const streamId = conversation.streamId
  const hiddenCount = Math.max(0, totalReplies - recentMessages.length)
  const ContextGlyph = (streamType && TYPE_GLYPH[streamType]) || MessageSquareText

  const {
    data: allMessages,
    isError: expandFailed,
    refetch: refetchMessages,
  } = useQuery({
    queryKey: conversationKeys.boardMessages(conversation.id),
    queryFn: () => conversationService.getBoardMessages(workspaceId, conversation.id),
    enabled: expanded,
    staleTime: 60_000,
  })

  // Expanded: the full conversation minus the opening (which renders above).
  // Collapsed: just the trailing replies the feed already carried.
  const replies: RenderableMessage[] =
    expanded && allMessages ? allMessages.filter((m) => m.id !== openingMessage?.id) : recentMessages
  const loadingMore = expanded && !allMessages && !expandFailed
  // No middle is hidden, so opening + replies form one uninterrupted run that
  // groups across the boundary. Otherwise a gap row sits between them.
  const contiguous = (expanded && !!allMessages) || (!expanded && hiddenCount === 0)

  const renderMessage = (message: RenderableMessage, continuation: boolean) => (
    <PostMessage
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
          (openingMessage ? [openingMessage, ...replies] : replies).map((message, i, all) =>
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
            {replies.map((message, i) => renderMessage(message, i > 0 && isContinuation(replies[i - 1], message)))}
          </>
        )}
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
  /** A same-author follow-up: drop the avatar/header and align the body under
   * the head row's content (matches the timeline's grouped continuations). */
  continuation?: boolean
}

function PostMessage({ workspaceId, streamId, message, authorName, currentUserId, continuation }: PostMessageProps) {
  const { formatTime, formatFull } = useFormattedDate()
  const { openUserProfile } = useUserProfile()
  const hasReactions = Object.keys(message.reactions).length > 0
  // Users open their profile on click (same as the timeline); other actor types
  // (persona/bot/system) are non-interactive.
  const interactiveName = message.authorType === "user" && Boolean(message.authorId)
  const attachments = message.attachments ?? []
  const linkPreviews = message.linkPreviews ?? []

  const richBody = (
    <>
      <MarkdownContent content={message.contentMarkdown} messageId={message.id} className="text-sm leading-relaxed" />
      {attachments.length > 0 && <AttachmentList attachments={attachments} workspaceId={workspaceId} />}
      {linkPreviews.length > 0 && (
        <LinkPreviewList
          messageId={message.id}
          workspaceId={workspaceId}
          previews={linkPreviews}
          hydrateFromApi={false}
        />
      )}
      {/* Memo + giphy embeds are parsed from the markdown, so they render here
          just like the timeline — no extra payload needed. */}
      <MemoPreviewList contentMarkdown={message.contentMarkdown} />
      <GiphyPreviewList contentMarkdown={message.contentMarkdown} />
    </>
  )
  // The body renders real message content (mentions, attachments, link previews),
  // so it gets the same markdown context wrappers the timeline uses. Attachments
  // open the media gallery / download via AttachmentList.
  const body = (
    <>
      <LinkPreviewProvider>
        {attachments.length > 0 ? (
          <AttachmentProvider workspaceId={workspaceId} attachments={attachments}>
            {richBody}
          </AttachmentProvider>
        ) : (
          richBody
        )}
      </LinkPreviewProvider>
      {hasReactions && (
        <MessageReactions
          reactions={message.reactions}
          workspaceId={workspaceId}
          messageId={message.id}
          currentUserId={currentUserId}
        />
      )}
    </>
  )

  if (continuation) {
    const sentAt = new Date(message.createdAt)
    return (
      <div className="group mt-0.5 flex gap-3">
        {/* Gutter reveals the message time on hover (desktop), mirroring the
            timeline's grouped-continuation micro-time. */}
        <div
          className="w-8 shrink-0 pt-0.5 text-right font-mono text-[10px] tabular-nums leading-5 text-transparent transition-colors group-hover:text-muted-foreground/60"
          title={formatFull(sentAt)}
        >
          {formatTime(sentAt)}
        </div>
        <div className="min-w-0 flex-1">{body}</div>
      </div>
    )
  }

  return (
    <div className="mt-3 flex items-start gap-3">
      <ActorAvatar
        actorId={message.authorId}
        actorType={message.authorType}
        workspaceId={workspaceId}
        size="md"
        alt={authorName}
        showStatus={false}
      />
      <div className="min-w-0 flex-1">
        <div className="mb-0.5 flex items-baseline gap-2">
          {interactiveName ? (
            <button
              type="button"
              onClick={() => openUserProfile(message.authorId)}
              className="truncate text-left text-sm font-semibold hover:underline"
            >
              {authorName}
            </button>
          ) : (
            <span className="truncate text-sm font-semibold">{authorName}</span>
          )}
          {/* Permalink to the message in its stream timeline — the body is
              interactive, so navigation lives on the timestamp instead. */}
          <Link
            to={`/w/${workspaceId}/s/${streamId}?m=${message.id}`}
            className="shrink-0 text-xs text-muted-foreground hover:underline"
          >
            <RelativeTime date={message.createdAt} />
          </Link>
        </div>
        {body}
      </div>
    </div>
  )
}
