import { Link } from "react-router-dom"
import { Hash, FileEdit, User, MessageSquareText, type LucideIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { RelativeTime } from "@/components/relative-time"
import { CompletenessIndicator } from "@/components/conversations/conversation-item"
import type { ConversationWithStaleness } from "@threa/types"

interface BoardCardProps {
  workspaceId: string
  conversation: ConversationWithStaleness
  /** The card's headline. The page resolves it: a scratchpad's own name, or the
   * conversation's topic for channels/DMs (never the DM peer — that's a person). */
  title: string
  /** The small context line under the title: the stream the conversation lives
   * in (channel name, DM peer), or "Scratchpad" when the name is the title. */
  contextLabel: string
  /** Resolved stream type, selecting the leading glyph. Falls back to a generic
   * thread glyph when the stream isn't in the bootstrap cache. */
  streamType: string | undefined
}

/** Leading glyph per stream type — mirrors the sidebar's stream-type vocabulary
 * so a channel reads the same here as it does in the rail. */
const TYPE_GLYPH: Record<string, { icon: LucideIcon; tint: string }> = {
  channel: { icon: Hash, tint: "text-[hsl(200_60%_50%)]" },
  scratchpad: { icon: FileEdit, tint: "text-primary" },
  dm: { icon: User, tint: "text-muted-foreground" },
}
const FALLBACK_GLYPH = { icon: MessageSquareText, tint: "text-muted-foreground" }

/** active is the resting state and most rows are active — surfacing it would be
 * noise (INV-63 spirit). Only the states that ask for attention get a marker. */
const STATUS_MARK: Record<string, { dot: string; label: string }> = {
  stalled: { dot: "bg-amber-500", label: "Stalled" },
  resolved: { dot: "bg-muted-foreground/40", label: "Resolved" },
}

/**
 * One board "post": a conversation (Threa's topic primitive) rendered as a quiet,
 * scannable row — same rhythm as the activity feed and timeline, not a boxy card.
 * Links to the conversation opened in its own stream. Cross-stream, so the leading
 * glyph + context line show where it lives. Stale conversations dim.
 */
export function BoardCard({ workspaceId, conversation, title, contextLabel, streamType }: BoardCardProps) {
  const { streamId, messageIds, status, lastActivityAt, effectiveCompleteness, temporalStaleness } = conversation
  const to = `/w/${workspaceId}/s/${streamId}?convView=open&conv=${conversation.id}`

  const glyph = (streamType && TYPE_GLYPH[streamType]) || FALLBACK_GLYPH
  const Glyph = glyph.icon
  const statusMark = STATUS_MARK[status]
  const messageCount = messageIds.length

  return (
    <Link
      to={to}
      className={cn(
        "group flex items-start gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-muted/50 sm:px-4 sm:py-3",
        temporalStaleness >= 3 && "opacity-60 hover:opacity-100"
      )}
    >
      <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-muted">
        <Glyph className={cn("h-4 w-4", glyph.tint)} />
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-3">
          <p className="truncate text-sm font-medium">{title}</p>
          <RelativeTime date={lastActivityAt} terse className="shrink-0 text-xs text-muted-foreground" />
        </div>
        <div className="mt-0.5 flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <span className="truncate">{contextLabel}</span>
            <span aria-hidden>·</span>
            <span className="shrink-0">
              {messageCount} {messageCount === 1 ? "message" : "messages"}
            </span>
            {statusMark && (
              <>
                <span aria-hidden>·</span>
                <span className="flex shrink-0 items-center gap-1">
                  <span className={cn("h-1.5 w-1.5 rounded-full", statusMark.dot)} />
                  {statusMark.label}
                </span>
              </>
            )}
          </div>
          <CompletenessIndicator score={effectiveCompleteness} />
        </div>
      </div>
    </Link>
  )
}
