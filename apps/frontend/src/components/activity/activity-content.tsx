import { cn } from "@/lib/utils"
import { RelativeTime } from "@/components/relative-time"
import { stripMarkdownToInline } from "@/lib/markdown"

/**
 * Per-type display shape. `actor-prefixed` rows read "<Actor> <verb> <stream>"
 * (or "You <selfVerb> <stream>" on the Me tab). `verb-only` rows stand alone,
 * which is how saved-reminders read — no meaningful human actor, just the
 * event itself.
 */
type ActivityDisplay = { kind: "actor-prefixed"; verb: string; selfVerb: string } | { kind: "verb-only"; verb: string }

const ACTIVITY_DISPLAY: Record<string, ActivityDisplay> = {
  mention: { kind: "actor-prefixed", verb: "mentioned you in", selfVerb: "You mentioned someone in" },
  message: { kind: "actor-prefixed", verb: "posted in", selfVerb: "You posted in" },
  reaction: { kind: "actor-prefixed", verb: "reacted to a message in", selfVerb: "You reacted to a message in" },
  saved_reminder: { kind: "verb-only", verb: "Reminder for message in" },
  member_added: { kind: "actor-prefixed", verb: "added you to", selfVerb: "You were added to" },
}

// Standalone (message-less) saved-item reminders have no stream to name —
// the row reads "Reminder" followed by the item's title preview.
const STANDALONE_REMINDER_VERB = "Reminder"

const DEFAULT_DISPLAY: ActivityDisplay = ACTIVITY_DISPLAY.message

interface ActivityPreviewProps {
  contentPreview: string
  toEmoji?: (shortcode: string) => string | null
}

/**
 * Single-line preview of the message that triggered the activity.
 * Strips markdown, collapses newlines, optionally resolves emoji shortcodes,
 * and renders nothing when there's no displayable content.
 */
export function ActivityPreview({ contentPreview, toEmoji }: ActivityPreviewProps) {
  const previewText = stripMarkdownToInline(contentPreview, toEmoji)
  if (!previewText) return null
  return <p className="mt-0.5 text-xs text-muted-foreground truncate">{previewText}</p>
}

interface ActivityContentProps {
  actorName: string
  streamName: string
  activityType: string
  contentPreview: string
  /** Emoji character for reaction activities; null for other types. */
  emoji?: string | null
  /** Resolver for :shortcode: emoji inside the content preview. */
  toEmoji?: (shortcode: string) => string | null
  createdAt: string
  isUnread: boolean
  isSelf: boolean
}

export function ActivityContent({
  actorName,
  streamName,
  activityType,
  contentPreview,
  emoji,
  toEmoji,
  createdAt,
  isUnread,
  isSelf,
}: ActivityContentProps) {
  const display = ACTIVITY_DISPLAY[activityType] ?? DEFAULT_DISPLAY
  // Empty streamName marks a stream-less row (standalone saved-item reminder)
  const hasStream = streamName !== ""
  let verb = display.kind === "actor-prefixed" && isSelf ? display.selfVerb : display.verb
  if (!hasStream && activityType === "saved_reminder") verb = STANDALONE_REMINDER_VERB
  const showActor = display.kind === "actor-prefixed" && !isSelf
  const showEmoji = activityType === "reaction" && emoji

  return (
    <div className="flex-1 min-w-0">
      <div className="flex items-baseline gap-1.5 text-sm">
        {showActor && <span className={cn("font-medium", isUnread && "font-semibold")}>{actorName}</span>}
        <span className="text-muted-foreground">{verb}</span>
        {hasStream && <span className="font-medium truncate">{streamName}</span>}
        {showEmoji && <span className="shrink-0">{emoji}</span>}
      </div>

      <ActivityPreview contentPreview={contentPreview} toEmoji={toEmoji} />

      <RelativeTime date={createdAt} className="text-xs text-muted-foreground/60 mt-1 block" />
    </div>
  )
}
