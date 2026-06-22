import { Link } from "react-router-dom"
import { cn } from "@/lib/utils"
import { RelativeTime } from "@/components/relative-time"
import { useStreamName } from "@/hooks/use-stream-name"
import { StatusBadge, CompletenessIndicator } from "@/components/conversations/conversation-item"
import type { ConversationWithStaleness } from "@threa/types"

interface BoardCardProps {
  workspaceId: string
  conversation: ConversationWithStaleness
}

/**
 * A single board "post": one conversation rendered as a card that links to the
 * conversation opened in its own stream (`?convView=open&conv=`). Cross-stream,
 * so the stream label is shown — it's the context the in-stream conversation
 * list doesn't need. Stale conversations dim, matching the in-stream list.
 */
export function BoardCard({ workspaceId, conversation }: BoardCardProps) {
  const { streamId, topicSummary, messageIds, status, lastActivityAt, effectiveCompleteness, temporalStaleness } =
    conversation
  const streamName = useStreamName(workspaceId, streamId, "generic") ?? "Unknown stream"
  const to = `/w/${workspaceId}/s/${streamId}?convView=open&conv=${conversation.id}`

  return (
    <Link
      to={to}
      className={cn(
        "block rounded-lg border bg-card p-3 transition-colors hover:bg-accent/50",
        temporalStaleness >= 3 && "opacity-60"
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs text-muted-foreground">{streamName}</p>
          <p className="mt-0.5 truncate text-sm font-medium">{topicSummary || "Untitled conversation"}</p>
          <div className="mt-1 flex items-center gap-2">
            <span className="text-xs text-muted-foreground">{messageIds.length} messages</span>
            <StatusBadge status={status} />
          </div>
        </div>
        <div className="flex flex-shrink-0 flex-col items-end gap-1">
          <CompletenessIndicator score={effectiveCompleteness} />
          <RelativeTime date={lastActivityAt} className="text-xs text-muted-foreground" />
        </div>
      </div>
    </Link>
  )
}
