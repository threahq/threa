import { Link } from "react-router-dom"
import { AtSign, Bell } from "lucide-react"
import { cn } from "@/lib/utils"
import { buildConversationPanelPath } from "@/lib/stream-links"
import { resolveEmojiShortcodes } from "@/lib/markdown"
import { isActivityUnread } from "@/hooks/use-activity-sections"
import { URGENCY_COLORS } from "@/components/layout/sidebar/config"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { PersonaAvatar } from "@/components/persona-avatar"
import { ActivityContent } from "./activity-content"
import type { Activity } from "@threa/types"

/** Shape returned by `useActors(...).getActorAvatar`. Repeated here to avoid a
 *  cross-hook type import and to document what each field is used for. */
export interface ActivityItemAvatar {
  fallback: string
  /** Persona slug — when present, a `PersonaAvatar` is rendered (SVG for Ariadne, emoji/initials otherwise). */
  slug?: string
  /** Stored photo URL for users/bots; takes precedence over the fallback. */
  avatarUrl?: string
}

/**
 * Which strand of the sidebar's urgency vocabulary (`URGENCY_COLORS`) a row
 * belongs to. Same four meanings the stream list uses — red is a mention, gold
 * is a persona, green is a bot, blue is everything else — so gold keeps meaning
 * "an agent did this" here instead of "unread".
 */
export function activityUrgency(activity: Activity): keyof typeof URGENCY_COLORS {
  if (activity.activityType === "mention") return "mentions"
  if (activity.actorType === "persona") return "ai"
  if (activity.actorType === "bot") return "bot"
  return "activity"
}

interface ActivityItemProps {
  activity: Activity
  actorName: string
  actorAvatar: ActivityItemAvatar
  streamName: string
  workspaceId: string
  toEmoji?: (shortcode: string) => string | null
  onMarkAsRead: (activityId: string) => void
  /**
   * Row is held in the Unread section but has since been read — this visit's
   * "you just opened this". Keeps a faded rail and a hollow dot so the row
   * still reads as part of the unread batch without competing with what's left.
   */
  wasReadThisVisit?: boolean
}

export function ActivityItem({
  activity,
  actorName,
  actorAvatar,
  streamName,
  workspaceId,
  toEmoji,
  onMarkAsRead,
  wasReadThisVisit = false,
}: ActivityItemProps) {
  // Self rows are inserted already read by the backend, so the unread dot is
  // never shown for them regardless of the `readAt` value. Give them a muted
  // background so they're visually distinct from things others did.
  const isSelf = activity.isSelf
  const isUnread = isActivityUnread(activity)
  const contentPreview = (activity.context.contentPreview as string) ?? ""
  const actorType = activity.actorType
  const isPersona = actorType === "persona"
  const isBot = actorType === "bot"
  const isSystem = actorType === "system"
  const isReminder = activity.activityType === "saved_reminder"
  const href = resolveActivityHref(workspaceId, activity)
  const urgency = activityUrgency(activity)
  // The reaction's own glyph, resolved: the wire carries either a raw character
  // or a `:shortcode:` (both shapes are emitted — see the activity service).
  const reactionEmoji =
    activity.activityType === "reaction" && activity.emoji ? resolveEmojiShortcodes(activity.emoji, toEmoji) : null

  return (
    <Link
      to={href}
      onClick={() => {
        if (isUnread) onMarkAsRead(activity.id)
      }}
      className={cn(
        "group flex items-stretch rounded-lg transition-colors",
        isUnread && "bg-muted/40 hover:bg-muted/70",
        !isUnread && !isSelf && "hover:bg-muted/50",
        isSelf && "opacity-75 hover:bg-muted/40 hover:opacity-100"
      )}
    >
      {/* Urgency strip, the sidebar's signal for the same thing (`UrgencyStrip`
          in `sidebar/stream-item.tsx`). The slot is always 4px wide and only the
          colour changes, so reading a row can't shift it (INV-21). */}
      <span
        aria-hidden
        className="w-1 shrink-0 rounded-l-lg transition-colors"
        style={{
          backgroundColor: isUnread || wasReadThisVisit ? URGENCY_COLORS[urgency] : URGENCY_COLORS.quiet,
          opacity: !isUnread && wasReadThisVisit ? 0.3 : 1,
        }}
      />
      <div className="flex min-w-0 flex-1 items-start gap-3 px-3 py-2.5 sm:px-4 sm:py-3">
        <div className="relative shrink-0">
          {renderAvatar({ isReminder, isPersona, isSystem, isBot, actorAvatar, actorName })}
          {renderTypeGlyph(activity.activityType, reactionEmoji)}
        </div>
        <ActivityContent
          actorName={actorName}
          streamName={streamName}
          activityType={activity.activityType}
          contentPreview={contentPreview}
          toEmoji={toEmoji}
          createdAt={activity.createdAt}
          urgencyColor={URGENCY_COLORS[urgency]}
          isUnread={isUnread}
          wasReadThisVisit={wasReadThisVisit}
          isSelf={isSelf}
        />
      </div>
    </Link>
  )
}

/**
 * Where an activity row navigates. A saved-reminder for a message saved from a
 * conversation carries `context.conversationId` and reopens the conversation
 * panel; otherwise the source-message stream permalink. Standalone saved-item
 * reminders have no source message — land on the Saved page where the item lives.
 */
function resolveActivityHref(workspaceId: string, activity: Activity): string {
  const conversationId = activity.context.conversationId
  if (typeof conversationId === "string" && conversationId) {
    return buildConversationPanelPath(workspaceId, conversationId, activity.messageId ?? undefined)
  }
  if (activity.streamId) return `/w/${workspaceId}/s/${activity.streamId}?m=${activity.messageId}`
  return `/w/${workspaceId}/saved`
}

/**
 * Corner badge on the avatar. A reaction shows the emoji it actually was — the
 * one thing the caption can't say — and a mention shows an @. Every other type
 * is already unambiguous in the verb line, so it gets nothing.
 */
function renderTypeGlyph(activityType: string, reactionEmoji: string | null) {
  const badge =
    "absolute -bottom-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full ring-2 ring-background"
  if (activityType === "reaction") {
    if (!reactionEmoji) return null
    // Not `aria-hidden`: which emoji it was is the row's payload, and the verb
    // line ("reacted to a message in …") can't carry it.
    return <span className={cn(badge, "bg-background text-[10px] leading-none")}>{reactionEmoji}</span>
  }
  if (activityType === "mention") {
    return (
      <span aria-hidden className={cn(badge, "text-white")} style={{ backgroundColor: URGENCY_COLORS.mentions }}>
        <AtSign className="h-2.5 w-2.5" strokeWidth={3} />
      </span>
    )
  }
  return null
}

function renderAvatar(params: {
  isReminder: boolean
  isPersona: boolean
  isSystem: boolean
  isBot: boolean
  actorAvatar: ActivityItemAvatar
  actorName: string
}) {
  const { isReminder, isPersona, isSystem, isBot, actorAvatar, actorName } = params
  // Saved-reminder rows don't have a meaningful actor — render a Bell glyph
  // instead of "T for Threa" so the avatar matches the verb ("Reminder for…").
  if (isReminder) {
    return (
      <div className="h-8 w-8 shrink-0 rounded-[8px] bg-amber-500/10 text-amber-500 flex items-center justify-center">
        <Bell className="h-4 w-4" />
      </div>
    )
  }
  if (isPersona) {
    return (
      <PersonaAvatar
        slug={actorAvatar.slug}
        avatarUrl={actorAvatar.avatarUrl}
        fallback={actorAvatar.fallback}
        size="md"
      />
    )
  }
  return (
    <Avatar className="h-8 w-8 rounded-[8px] shrink-0">
      {actorAvatar.avatarUrl && <AvatarImage src={actorAvatar.avatarUrl} alt={actorName} />}
      <AvatarFallback
        className={cn(
          "text-xs text-foreground",
          isSystem && "bg-blue-500/10 text-blue-500",
          isBot && "bg-emerald-500/10 text-emerald-600",
          !isSystem && !isBot && "bg-muted"
        )}
      >
        {actorAvatar.fallback}
      </AvatarFallback>
    </Avatar>
  )
}
