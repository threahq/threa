import { useState } from "react"
import { Link } from "react-router-dom"
import { useQuery } from "@tanstack/react-query"
import { Hash, FileEdit, User, MessageSquareText, ChevronDown, type LucideIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { PersonaAvatar } from "@/components/persona-avatar"
import { RelativeTime } from "@/components/relative-time"
import { useActors } from "@/hooks"
import { useWorkspaceEmoji } from "@/hooks/use-workspace-emoji"
import { useConversationService } from "@/contexts"
import { conversationKeys } from "@/hooks/use-conversations"
import { stripMarkdownToInline } from "@/lib/markdown/strip"
import type { ActorLookup } from "@/hooks/use-actors"
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

const MAX_REACTIONS = 4

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
 * One board post: a conversation rendered as a threaded feed post. The opening
 * message is the body, the latest replies sit beneath it, and a collapsed
 * "N more messages" gap fills in on click. The conversation is context (header),
 * not the unit. Each message links to itself in its stream timeline — no
 * conversations pane. Width is constrained by the page to match the timeline.
 */
export function BoardCard({ workspaceId, post, topic, contextLabel, streamType }: BoardCardProps) {
  const { conversation, openingMessage, recentMessages } = post
  const actors = useActors(workspaceId)
  const { toEmoji } = useWorkspaceEmoji(workspaceId)
  const conversationService = useConversationService()
  const [expanded, setExpanded] = useState(false)

  const streamId = conversation.streamId
  const messageCount = conversation.messageIds.length
  const hiddenCount = Math.max(0, messageCount - (openingMessage ? 1 : 0) - recentMessages.length)
  const ContextGlyph = (streamType && TYPE_GLYPH[streamType]) || MessageSquareText

  const { data: allMessages } = useQuery({
    queryKey: conversationKeys.messages(conversation.id),
    queryFn: () => conversationService.getMessages(workspaceId, conversation.id),
    enabled: expanded,
    staleTime: 60_000,
  })

  // Expanded: the full conversation minus the opening (which renders above).
  // Collapsed: just the trailing replies the feed already carried.
  const replies: RenderableMessage[] =
    expanded && allMessages ? allMessages.filter((m) => m.id !== openingMessage?.id) : recentMessages
  const loadingMore = expanded && !allMessages

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

      <div className="mt-2">
        {openingMessage && (
          <PostMessage
            workspaceId={workspaceId}
            streamId={streamId}
            message={openingMessage}
            actors={actors}
            toEmoji={toEmoji}
            emphasis
          />
        )}

        {(replies.length > 0 || hiddenCount > 0 || loadingMore) && (
          <div className="ml-3 mt-1 flex flex-col gap-1 border-l pl-3 sm:ml-4 sm:pl-4">
            {!expanded && hiddenCount > 0 && (
              <button
                type="button"
                onClick={() => setExpanded(true)}
                className="flex w-fit items-center gap-1 py-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                <ChevronDown className="h-3.5 w-3.5" />
                {hiddenCount} more {hiddenCount === 1 ? "message" : "messages"}
              </button>
            )}
            {loadingMore && <span className="py-0.5 text-xs text-muted-foreground">Loading messages…</span>}
            {replies.map((message) => (
              <PostMessage
                key={message.id}
                workspaceId={workspaceId}
                streamId={streamId}
                message={message}
                actors={actors}
                toEmoji={toEmoji}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

interface PostMessageProps {
  workspaceId: string
  streamId: string
  message: RenderableMessage
  actors: ActorLookup
  toEmoji: (shortcode: string) => string | null
  /** The opening post — slightly larger body clamp than a reply. */
  emphasis?: boolean
}

function PostMessage({ workspaceId, streamId, message, actors, toEmoji, emphasis }: PostMessageProps) {
  const name = actors.getActorName(message.authorId, message.authorType)
  const avatar = actors.getActorAvatar(message.authorId, message.authorType)
  const body = stripMarkdownToInline(message.contentMarkdown, toEmoji).trim()
  const to = `/w/${workspaceId}/s/${streamId}?m=${message.id}`

  return (
    <Link to={to} className="-mx-2 block rounded-lg px-2 py-1.5 transition-colors hover:bg-muted/50">
      <div className="flex items-start gap-2">
        {message.authorType === "persona" ? (
          <PersonaAvatar slug={avatar.slug} fallback={avatar.fallback} size={emphasis ? "md" : "sm"} />
        ) : (
          <Avatar className={cn("shrink-0 rounded-[8px]", emphasis ? "h-8 w-8" : "h-6 w-6")}>
            {avatar.avatarUrl && <AvatarImage src={avatar.avatarUrl} alt={name} />}
            <AvatarFallback
              className={cn(
                "rounded-[8px] bg-muted text-xs text-foreground",
                message.authorType === "bot" && "bg-emerald-500/10 text-emerald-600",
                message.authorType === "system" && "bg-blue-500/10 text-blue-500"
              )}
            >
              {avatar.fallback}
            </AvatarFallback>
          </Avatar>
        )}

        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="truncate text-sm font-medium">{name}</span>
            <RelativeTime date={message.createdAt} terse className="ml-auto shrink-0 text-xs text-muted-foreground" />
          </div>
          {body && (
            <p className={cn("mt-0.5 break-words text-sm leading-relaxed", emphasis ? "line-clamp-4" : "line-clamp-2")}>
              {body}
            </p>
          )}
          <ReactionChips reactions={message.reactions} toEmoji={toEmoji} />
        </div>
      </div>
    </Link>
  )
}

function ReactionChips({
  reactions,
  toEmoji,
}: {
  reactions: Record<string, string[]>
  toEmoji: (shortcode: string) => string | null
}) {
  const sorted = Object.entries(reactions)
    .filter(([, users]) => users.length > 0)
    .sort((a, b) => b[1].length - a[1].length)
  if (sorted.length === 0) return null

  const visible = sorted.slice(0, MAX_REACTIONS)
  const overflow = sorted.length - visible.length

  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
      {visible.map(([shortcode, users]) => (
        <span key={shortcode} className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 leading-none">
          <span>{toEmoji(shortcode) ?? shortcode}</span>
          <span>{users.length}</span>
        </span>
      ))}
      {overflow > 0 && <span>+{overflow}</span>}
    </div>
  )
}
