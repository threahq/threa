import { Link } from "react-router-dom"
import { MessagesSquare } from "lucide-react"
import { RelativeTime } from "@/components/relative-time"
import { useStreamName } from "@/hooks/use-stream-name"
import { cn } from "@/lib/utils"
import type { ConversationSearchResult } from "@/api"

/**
 * Top conversation matches for a search query: whole discussions whose topic
 * matched semantically, rendered as their own group above message results on
 * the search page and sidebar search panel. Renders nothing when the leg
 * returned no hits (exact and keyword-only searches never produce any).
 */
export function ConversationMatches({
  workspaceId,
  conversations,
  compact = false,
}: {
  workspaceId: string
  conversations: ConversationSearchResult[]
  /** Clamps the summary to one line, for the sidebar panel's narrower column. */
  compact?: boolean
}) {
  if (conversations.length === 0) return null

  return (
    <div className="mb-3 border-b border-border/50 pb-3">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="text-[11px] uppercase tracking-wide text-muted-foreground">Conversations</span>
      </div>
      <ul className="flex flex-col gap-1.5">
        {conversations.map((conversation) => (
          <li key={conversation.id}>
            <ConversationMatchItem workspaceId={workspaceId} conversation={conversation} compact={compact} />
          </li>
        ))}
      </ul>
    </div>
  )
}

function ConversationMatchItem({
  workspaceId,
  conversation,
  compact,
}: {
  workspaceId: string
  conversation: ConversationSearchResult
  compact: boolean
}) {
  const streamName = useStreamName(workspaceId, conversation.streamId) ?? "Unknown"
  const anchor = conversation.firstMessageId ? `?m=${conversation.firstMessageId}` : ""
  const title = conversation.topicSummary ?? conversation.summary ?? "Untitled conversation"
  const summary = conversation.topicSummary ? conversation.summary : null

  return (
    <Link
      to={`/w/${workspaceId}/s/${conversation.streamId}${anchor}`}
      className="group block overflow-hidden rounded-lg border-l-[3px] border border-l-transparent border-border/50 bg-card transition-all hover:border-border hover:shadow-sm [overflow-wrap:anywhere]"
    >
      <div className="min-w-0 px-3.5 py-3">
        <div className="flex min-w-0 items-start justify-between gap-2">
          <h3 className="min-w-0 flex-1 text-[13px] font-semibold leading-snug text-foreground line-clamp-2">
            {title}
          </h3>
          {conversation.lastMessageAt && (
            <RelativeTime
              date={conversation.lastMessageAt}
              className="mt-0.5 shrink-0 text-[10px] tabular-nums text-muted-foreground/70"
              terse
            />
          )}
        </div>

        {summary && (
          <p
            className={cn(
              "mt-1.5 text-xs leading-relaxed text-muted-foreground",
              compact ? "line-clamp-1" : "line-clamp-2"
            )}
          >
            {summary}
          </p>
        )}

        <div className="mt-2 flex min-w-0 items-center gap-2 text-[10px] text-muted-foreground/70">
          <span className="truncate">{streamName}</span>
          <span className="inline-flex shrink-0 items-center gap-1 tabular-nums">
            <MessagesSquare className="h-2.5 w-2.5" />
            {conversation.messageCount} {conversation.messageCount === 1 ? "message" : "messages"}
          </span>
        </div>
      </div>
    </Link>
  )
}
