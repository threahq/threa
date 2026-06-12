import { Link } from "react-router-dom"
import { Bell } from "lucide-react"
import { cn } from "@/lib/utils"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { PersonaAvatar } from "@/components/persona-avatar"
import { UnreadDot } from "./unread-dot"
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

interface ActivityItemProps {
  activity: Activity
  actorName: string
  actorAvatar: ActivityItemAvatar
  streamName: string
  workspaceId: string
  toEmoji?: (shortcode: string) => string | null
  onMarkAsRead: (activityId: string) => void
}

export function ActivityItem({
  activity,
  actorName,
  actorAvatar,
  streamName,
  workspaceId,
  toEmoji,
  onMarkAsRead,
}: ActivityItemProps) {
  // Self rows are inserted already read by the backend, so the unread dot is
  // never shown for them regardless of the `readAt` value. Give them a muted
  // background so they're visually distinct from things others did.
  const isSelf = activity.isSelf
  const isUnread = !isSelf && !activity.readAt
  const contentPreview = (activity.context.contentPreview as string) ?? ""
  const actorType = activity.actorType
  const isPersona = actorType === "persona"
  const isBot = actorType === "bot"
  const isSystem = actorType === "system"
  const isReminder = activity.activityType === "saved_reminder"
  // Standalone saved-item reminders have no source message to open — land on
  // the Saved page where the item lives.
  const href = activity.streamId
    ? `/w/${workspaceId}/s/${activity.streamId}?m=${activity.messageId}`
    : `/w/${workspaceId}/saved`

  return (
    <Link
      to={href}
      onClick={() => {
        if (isUnread) onMarkAsRead(activity.id)
      }}
      className={cn(
        "group flex items-start gap-3 rounded-lg px-4 py-3 transition-colors",
        isUnread && "bg-primary/5 hover:bg-primary/10",
        !isUnread && !isSelf && "hover:bg-muted/50",
        isSelf && "opacity-75 hover:bg-muted/40 hover:opacity-100"
      )}
    >
      <UnreadDot isUnread={isUnread} />
      {renderAvatar({ isReminder, isPersona, isSystem, isBot, actorAvatar, actorName })}
      <ActivityContent
        actorName={actorName}
        streamName={streamName}
        activityType={activity.activityType}
        contentPreview={contentPreview}
        emoji={activity.emoji}
        toEmoji={toEmoji}
        createdAt={activity.createdAt}
        isUnread={isUnread}
        isSelf={isSelf}
      />
    </Link>
  )
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
      <div className="h-7 w-7 shrink-0 rounded-[8px] bg-amber-500/10 text-amber-500 flex items-center justify-center">
        <Bell className="h-4 w-4" />
      </div>
    )
  }
  if (isPersona) {
    return <PersonaAvatar slug={actorAvatar.slug} fallback={actorAvatar.fallback} size="sm" />
  }
  return (
    <Avatar className="h-7 w-7 rounded-[8px] shrink-0">
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
