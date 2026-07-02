import { Link } from "react-router-dom"
import { Bell } from "lucide-react"
import { cn } from "@/lib/utils"
import { buildConversationPanelPath } from "@/lib/stream-links"
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
  const href = resolveActivityHref(workspaceId, activity)

  return (
    <Link
      to={href}
      onClick={() => {
        if (isUnread) onMarkAsRead(activity.id)
      }}
      className={cn(
        "group flex items-start gap-3 rounded-lg px-3 py-2.5 transition-colors sm:px-4 sm:py-3",
        isUnread && "bg-primary/5 hover:bg-primary/10",
        !isUnread && !isSelf && "hover:bg-muted/50",
        isSelf && "opacity-75 hover:bg-muted/40 hover:opacity-100"
      )}
    >
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
    return <PersonaAvatar slug={actorAvatar.slug} fallback={actorAvatar.fallback} size="md" />
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
