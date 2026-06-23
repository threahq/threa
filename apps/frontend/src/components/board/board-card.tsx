import { Link } from "react-router-dom"
import { Hash, FileEdit, User, MessageSquareText, MessagesSquare, type LucideIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { PersonaAvatar } from "@/components/persona-avatar"
import { RelativeTime } from "@/components/relative-time"
import { useActors } from "@/hooks"
import { useWorkspaceEmoji } from "@/hooks/use-workspace-emoji"
import { stripMarkdownToInline } from "@/lib/markdown/strip"
import type { BoardPost } from "@threa/types"

interface BoardCardProps {
  workspaceId: string
  post: BoardPost
  /** Topic of the grouping, resolved by the page (scratchpad name / channel topic).
   * Rendered as a subject line, not the headline — the message body is the unit. */
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

/**
 * One board post: a conversation surfaced as a feed post. The opening message is
 * the body (the unit is a message), the conversation is context (the grouping).
 * Reads like a re-organized timeline row, not a conversations-list card: author
 * header, message content, reactions, and a reply count — no status/completeness
 * chrome. Links to the conversation opened in its stream; stale posts dim.
 */
export function BoardCard({ workspaceId, post, topic, contextLabel, streamType }: BoardCardProps) {
  const { conversation, openingMessage } = post
  const { getActorName, getActorAvatar } = useActors(workspaceId)
  const { toEmoji } = useWorkspaceEmoji(workspaceId)

  const to = `/w/${workspaceId}/s/${conversation.streamId}?convView=open&conv=${conversation.id}`
  const ContextGlyph = (streamType && TYPE_GLYPH[streamType]) || MessageSquareText
  const messageCount = conversation.messageIds.length
  const body = openingMessage ? stripMarkdownToInline(openingMessage.contentMarkdown, toEmoji).trim() : ""

  const authorId = openingMessage?.authorId ?? null
  const authorType = openingMessage?.authorType ?? null
  const authorName = openingMessage ? getActorName(authorId, authorType) : "Threa"
  const avatar = getActorAvatar(authorId, authorType)

  const reactions = Object.entries(openingMessage?.reactions ?? {})
    .filter(([, users]) => users.length > 0)
    .sort((a, b) => b[1].length - a[1].length)
  const visibleReactions = reactions.slice(0, MAX_REACTIONS)
  const reactionOverflow = reactions.length - visibleReactions.length

  return (
    <Link
      to={to}
      className={cn(
        "group block rounded-xl px-3 py-3 transition-colors hover:bg-muted/40 sm:px-4",
        conversation.temporalStaleness >= 3 && "opacity-60 hover:opacity-100"
      )}
    >
      <div className="flex items-start gap-3">
        {authorType === "persona" ? (
          <PersonaAvatar slug={avatar.slug} fallback={avatar.fallback} size="md" />
        ) : (
          <Avatar className="h-9 w-9 shrink-0 rounded-[10px]">
            {avatar.avatarUrl && <AvatarImage src={avatar.avatarUrl} alt={authorName} />}
            <AvatarFallback
              className={cn(
                "rounded-[10px] bg-muted text-xs text-foreground",
                authorType === "bot" && "bg-emerald-500/10 text-emerald-600",
                authorType === "system" && "bg-blue-500/10 text-blue-500"
              )}
            >
              {avatar.fallback}
            </AvatarFallback>
          </Avatar>
        )}

        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="truncate text-sm font-medium">{authorName}</span>
            <span className="flex min-w-0 shrink items-center gap-1 text-xs text-muted-foreground">
              <ContextGlyph className="h-3 w-3 shrink-0" />
              <span className="truncate">{contextLabel}</span>
            </span>
            <RelativeTime
              date={conversation.lastActivityAt}
              terse
              className="ml-auto shrink-0 text-xs text-muted-foreground"
            />
          </div>

          {topic && <p className="mt-0.5 truncate text-xs text-muted-foreground">{topic}</p>}

          {body && <p className="mt-1.5 break-words text-sm leading-relaxed line-clamp-4">{body}</p>}

          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
            {visibleReactions.map(([shortcode, users]) => (
              <span
                key={shortcode}
                className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 leading-none"
              >
                <span>{toEmoji(shortcode) ?? shortcode}</span>
                <span>{users.length}</span>
              </span>
            ))}
            {reactionOverflow > 0 && <span>+{reactionOverflow}</span>}
            <span className="inline-flex items-center gap-1">
              <MessagesSquare className="h-3.5 w-3.5" />
              {messageCount} {messageCount === 1 ? "message" : "messages"}
            </span>
          </div>
        </div>
      </div>
    </Link>
  )
}
