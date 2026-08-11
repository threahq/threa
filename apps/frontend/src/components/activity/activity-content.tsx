import type { CSSProperties } from "react"
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
  missed_call: { kind: "actor-prefixed", verb: "called you in", selfVerb: "You called" },
}

// Standalone (message-less) saved-item reminders have no stream to name —
// the row reads "Reminder" followed by the item's title preview.
const STANDALONE_REMINDER_VERB = "Reminder"

const DEFAULT_DISPLAY: ActivityDisplay = ACTIVITY_DISPLAY.message

interface ActivityPreviewProps {
  contentPreview: string
  toEmoji?: (shortcode: string) => string | null
  /** Unread rows render the content at full strength; read rows are dimmed. */
  isUnread?: boolean
}

/**
 * The message that triggered the activity — the actual payload of the
 * notification, so it carries the visual weight (body size, foreground colour)
 * while the actor/verb/stream line above it stays a muted caption. Strips
 * markdown, collapses newlines, optionally resolves emoji shortcodes, and
 * clamps to three lines.
 */
export function ActivityPreview({ contentPreview, toEmoji, isUnread }: ActivityPreviewProps) {
  const previewText = stripMarkdownToInline(contentPreview, toEmoji)
  if (!previewText) return null
  return (
    <p className={cn("mt-1 text-sm leading-snug line-clamp-3", isUnread ? "text-foreground" : "text-foreground/80")}>
      {previewText}
    </p>
  )
}

/** Solid while unread, a hollow ring once read this visit, invisible otherwise. */
function dotStyle(urgencyColor: string, isUnread: boolean, wasReadThisVisit: boolean): CSSProperties | undefined {
  if (isUnread) return { backgroundColor: urgencyColor }
  if (wasReadThisVisit) return { boxShadow: `inset 0 0 0 1px ${urgencyColor}`, opacity: 0.5 }
  return undefined
}

interface ActivityContentProps {
  actorName: string
  streamName: string
  activityType: string
  contentPreview: string
  /** Resolver for :shortcode: emoji inside the content preview. */
  toEmoji?: (shortcode: string) => string | null
  createdAt: string
  /** The row's `URGENCY_COLORS` entry — what the unread dot is painted with. */
  urgencyColor: string
  isUnread: boolean
  /** Held in the Unread section but already read — see `ActivityItem`. */
  wasReadThisVisit?: boolean
  isSelf: boolean
}

export function ActivityContent({
  actorName,
  streamName,
  activityType,
  contentPreview,
  toEmoji,
  createdAt,
  urgencyColor,
  isUnread,
  wasReadThisVisit = false,
  isSelf,
}: ActivityContentProps) {
  const display = ACTIVITY_DISPLAY[activityType] ?? DEFAULT_DISPLAY
  // Empty streamName marks a stream-less row (standalone saved-item reminder)
  const hasStream = streamName !== ""
  let verb = display.kind === "actor-prefixed" && isSelf ? display.selfVerb : display.verb
  if (!hasStream && activityType === "saved_reminder") verb = STANDALONE_REMINDER_VERB
  const showActor = display.kind === "actor-prefixed" && !isSelf

  return (
    <div className="min-w-0 flex-1">
      {/* Caption line. The whole actor/verb/stream cluster lives in one
          `truncate` block so it ellipsises as a unit on one line — the actor
          name can never wrap — and the timestamp stays pinned to the right edge
          (using the horizontal room that used to sit empty on mobile). */}
      <div className="flex items-baseline gap-2">
        <div className="min-w-0 flex-1 truncate text-[13px] leading-tight text-muted-foreground">
          {showActor && <span className="font-semibold text-foreground">{actorName}</span>}
          {showActor && " "}
          {verb}
          {hasStream && " "}
          {hasStream && <span className="font-medium text-foreground">{streamName}</span>}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <RelativeTime date={createdAt} terse className="text-xs tabular-nums text-muted-foreground/70" />
          {/* Unread marker, right-aligned with the time, painted the same
              urgency colour as the row's strip. Space is reserved when read
              (transparent) so toggling read/unread never shifts the row
              (INV-21). A row read during this visit keeps a hollow ring — it
              stays in the Unread section, so it must still read as part of that
              batch. Self rows are always read, so they get no marker. */}
          {!isSelf && (
            <>
              {/* The dot and the row's strip are both colour, so the state they
                  carry has to be said out loud too — a read row keeps its slot
                  in the Unread section, which is otherwise indistinguishable
                  from a still-unread one without sight. */}
              {(isUnread || wasReadThisVisit) && <span className="sr-only">{isUnread ? "Unread" : "Read"}</span>}
              <span
                aria-hidden
                className="h-2 w-2 rounded-full"
                style={dotStyle(urgencyColor, isUnread, wasReadThisVisit)}
              />
            </>
          )}
        </div>
      </div>

      <ActivityPreview contentPreview={contentPreview} toEmoji={toEmoji} isUnread={isUnread} />
    </div>
  )
}
