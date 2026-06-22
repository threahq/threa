import { Link } from "react-router-dom"
import { cn } from "@/lib/utils"
import { RelativeTime } from "@/components/relative-time"
import { StatusBadge, CompletenessIndicator } from "@/components/conversations/conversation-item"
import type { ConversationWithStaleness } from "@threa/types"

interface BoardCardProps {
  workspaceId: string
  conversation: ConversationWithStaleness
  /** The card's headline. The page resolves it: a scratchpad's own name, or the
   * conversation's topic for channels/DMs (never the DM peer — that's a person). */
  title: string
  /** The small context line above the title: the stream the conversation lives
   * in (channel name, DM peer), or "Scratchpad" when the name is the title. */
  contextLabel: string
}

/**
 * A single board "post": one conversation as a card linking to it opened in its
 * own stream (`?convView=open&conv=`). Cross-stream, so it shows where the
 * conversation lives. Stale conversations dim, matching the in-stream list.
 */
export function BoardCard({ workspaceId, conversation, title, contextLabel }: BoardCardProps) {
  const { streamId, messageIds, status, lastActivityAt, effectiveCompleteness, temporalStaleness } = conversation
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
          <p className="truncate text-xs text-muted-foreground">{contextLabel}</p>
          <p className="mt-0.5 truncate text-sm font-medium">{title}</p>
          <div className="mt-1 flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              {messageIds.length} {messageIds.length === 1 ? "message" : "messages"}
            </span>
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
