import { Smile } from "lucide-react"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { ReactionEmojiPicker } from "@/components/timeline/reaction-emoji-picker"
import { usePreferences } from "@/contexts"
import { useAuth } from "@/auth"
import { useWorkspaceUsers } from "@/stores/workspace-store"
import { formatBody, formatTitle, resolveActions, resolvePushActionLimit } from "@/lib/sw-notification-format"
import {
  ActivityTypes,
  DEFAULT_PUSH_ACTIONS,
  DEFAULT_PUSH_QUICK_REACTION,
  DEFAULT_PUSH_REMINDER_MINUTES,
  PUSH_ACTION_OPTIONS,
  PUSH_ACTIONS_MAX,
  PushActions,
  getAvatarUrl,
  type PushAction,
} from "@threahq/types"

const SLOT_LABELS = ["First button", "Second button"] as const
const NONE = "none"

const ACTION_LABELS: Record<PushAction, string> = {
  mark_read: "Mark read",
  remind: "Remind me",
  react: "React",
}

const REMINDER_OPTIONS = [
  { minutes: 5, label: "5 minutes" },
  { minutes: 15, label: "15 minutes" },
  { minutes: 30, label: "30 minutes" },
  { minutes: 60, label: "1 hour" },
  { minutes: 3 * 60, label: "3 hours" },
  { minutes: 24 * 60, label: "1 day" },
]

/**
 * Desktop Chrome renders up to `Notification.maxActions` buttons on a push;
 * Safari, iOS included, reports none and ignores them. Android reports a
 * non-zero count but cannot tell the worker which button was pressed
 * (`resolvePushActionLimit`), so the section stays hidden there rather than
 * offering settings no card will honour.
 */
export function supportsNotificationActions(): boolean {
  if (typeof Notification === "undefined") return false
  if (typeof navigator !== "undefined" && resolvePushActionLimit(navigator.userAgent) === 0) return false
  const maxActions = (Notification as unknown as { maxActions?: number }).maxActions
  return typeof maxActions === "number" && maxActions > 0
}

/** Put `action` in slot `index`; a slot that already held it elsewhere empties. */
export function assignSlot(actions: readonly PushAction[], index: number, action: PushAction | null): PushAction[] {
  const slots: Array<PushAction | null> = Array.from({ length: PUSH_ACTIONS_MAX }, (_, i) => actions[i] ?? null)
  if (action !== null) {
    const previous = slots.indexOf(action)
    if (previous !== -1 && previous !== index) slots[previous] = null
  }
  slots[index] = action
  return slots.filter((slot): slot is PushAction => slot !== null)
}

function NotificationPreview({
  workspaceId,
  actions,
  reminderMinutes,
  quickReaction,
}: {
  workspaceId: string
  actions: PushAction[]
  reminderMinutes: number
  quickReaction: string
}) {
  const { user } = useAuth()
  const users = useWorkspaceUsers(workspaceId)
  const currentUser = user ? users.find((u) => u.workosUserId === user.id) : undefined
  const senderName = currentUser?.name ?? "Ada"
  const avatarSrc = currentUser ? getAvatarUrl(workspaceId, currentUser.avatarUrl, 64) : undefined
  const messages = [{ authorName: senderName, contentPreview: "Lunch at noon?" }]
  const buttons = resolveActions(ActivityTypes.MESSAGE, {
    pushActions: actions,
    pushReminderMinutes: reminderMinutes,
    pushQuickReaction: quickReaction,
  })

  return (
    <div aria-label="Notification preview" className="max-w-sm rounded-lg border bg-card p-3 shadow-sm">
      <div className="flex items-start gap-3">
        <Avatar className="h-9 w-9">
          {avatarSrc && <AvatarImage src={avatarSrc} alt="" />}
          <AvatarFallback>{senderName.slice(0, 1).toUpperCase()}</AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{formatTitle(messages, "general")}</p>
          <p className="truncate text-sm text-muted-foreground">{formatBody(messages)}</p>
        </div>
      </div>
      {buttons.length > 0 && (
        <ul className="mt-3 flex gap-4 border-t pt-2">
          {buttons.map((button) => (
            <li key={button.action} className="text-sm font-medium text-primary">
              {button.title}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function PushActionsSection({ workspaceId }: { workspaceId: string }) {
  const { preferences, updatePreference } = usePreferences()
  const actions = preferences?.pushActions ?? [...DEFAULT_PUSH_ACTIONS]
  const reminderMinutes = preferences?.pushReminderMinutes ?? DEFAULT_PUSH_REMINDER_MINUTES
  const quickReaction = preferences?.pushQuickReaction ?? DEFAULT_PUSH_QUICK_REACTION

  if (!supportsNotificationActions()) {
    return (
      <section className="space-y-1">
        <h3 className="text-sm font-medium">Notification buttons</h3>
        <p className="text-sm text-muted-foreground">
          This device can't show buttons on a notification. Set them up from desktop Chrome, where they appear.
        </p>
      </section>
    )
  }

  return (
    <section className="space-y-4">
      <div>
        <h3 className="text-sm font-medium">Notification buttons</h3>
        <p className="text-sm text-muted-foreground">
          Act on a message straight from the notification. Buttons show on Android and desktop Chrome.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {SLOT_LABELS.map((label, index) => (
          <div key={label} className="space-y-1.5">
            <Label htmlFor={`push-action-${index}`}>{label}</Label>
            <Select
              value={actions[index] ?? NONE}
              onValueChange={(value) =>
                updatePreference(
                  "pushActions",
                  assignSlot(actions, index, value === NONE ? null : (value as PushAction))
                )
              }
            >
              <SelectTrigger id={`push-action-${index}`} aria-label={label} className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>None</SelectItem>
                {PUSH_ACTION_OPTIONS.map((option) => (
                  <SelectItem key={option} value={option}>
                    {ACTION_LABELS[option]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ))}
      </div>

      {actions.includes(PushActions.REMIND) && (
        <div className="space-y-1.5">
          <Label htmlFor="push-reminder-minutes">Remind me after</Label>
          <Select
            value={String(reminderMinutes)}
            onValueChange={(value) => updatePreference("pushReminderMinutes", Number(value))}
          >
            <SelectTrigger id="push-reminder-minutes" aria-label="Remind me after" className="h-9 w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {REMINDER_OPTIONS.map((option) => (
                <SelectItem key={option.minutes} value={String(option.minutes)}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {actions.includes(PushActions.REACT) && (
        <div className="space-y-1.5">
          <Label>Quick reaction</Label>
          <ReactionEmojiPicker
            workspaceId={workspaceId}
            onSelect={(emoji) => updatePreference("pushQuickReaction", emoji)}
            trigger={
              <button
                type="button"
                aria-label="Pick the quick reaction"
                className="flex h-9 w-9 items-center justify-center rounded-md border border-input text-lg hover:bg-muted/50"
              >
                {quickReaction || <Smile className="h-4 w-4 text-muted-foreground" />}
              </button>
            }
          />
        </div>
      )}

      <NotificationPreview
        workspaceId={workspaceId}
        actions={actions}
        reminderMinutes={reminderMinutes}
        quickReaction={quickReaction}
      />
    </section>
  )
}
