import { Smile } from "lucide-react"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { ReactionEmojiPicker } from "@/components/timeline/reaction-emoji-picker"
import { SETTING_CONTROL_HEIGHT, SettingsDisclosure, type SettingUnavailable } from "./setting-primitives"
import { SETTING_CHOICE_LABELS, settingDef } from "./settings-registry"
import { SettingListItem } from "./setting-lists"
import { useIsMobileOrCoarse } from "@/hooks/use-pointer"
import { usePreferences } from "@/contexts"
import { useAuth } from "@/auth"
import { useWorkspaceUsers } from "@/stores/workspace-store"
import { formatBody, formatTitle, resolveActions, resolvePushActionLimit } from "@/lib/sw-notification-format"
import type { PushDeviceState } from "@/hooks/push-device-state"
import {
  ActivityTypes,
  DEFAULT_PUSH_ACTIONS,
  DEFAULT_PUSH_QUICK_REACTION,
  DEFAULT_PUSH_REMINDER_MINUTES,
  PUSH_ACTION_OPTIONS,
  PUSH_ACTIONS_MAX,
  PushActions,
  getAvatarUrl,
  type PrefNotificationLevel,
  type PushAction,
} from "@threahq/types"

const SLOT_LABELS = ["First button", "Second button"] as const
const FIELD_CLASS = `w-40 shrink-0 ${SETTING_CONTROL_HEIGHT}`
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

/** One wording for the row's reason and for how search reads the buttons. */
function shownOnly(condition: string): SettingUnavailable {
  return { reason: `${condition}.`, value: condition }
}

const PUSH_BUTTONS_UNAVAILABLE = {
  unsupported: shownOnly("Only shown in desktop Chrome"),
  noPush: shownOnly(
    `Shown once “${settingDef("notification-level").label}” isn't “${SETTING_CHOICE_LABELS["notification-level"].none}”`
  ),
}

const SHOWN_ONCE_DEVICE_ON = `Shown once “${settingDef("push-device").label}” is on.`

/** Why the buttons can't show anywhere: no support here, or no pushes at all. */
export function pushButtonsUnavailable(supported: boolean, level: PrefNotificationLevel): SettingUnavailable | null {
  if (!supported) return PUSH_BUTTONS_UNAVAILABLE.unsupported
  if (level === "none") return PUSH_BUTTONS_UNAVAILABLE.noPush
  return null
}

/** The buttons a push carries, as the row's summary and search both read them. */
export function pushButtonsSummary(actions: readonly PushAction[]): string {
  return actions.length > 0 ? actions.map((action) => ACTION_LABELS[action]).join(", ") : "None"
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
    <div role="group" aria-label="Notification preview" className="max-w-sm rounded-md border bg-background p-3">
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

/**
 * The buttons on a push. Where they can't show, the row stays shut with the
 * reason; with push off on this device it stays editable, since the buttons
 * sync to the viewer's other devices.
 */
export function PushActionsSection({
  workspaceId,
  level,
  pushDevice,
}: {
  workspaceId: string
  level: PrefNotificationLevel
  pushDevice: PushDeviceState
}) {
  const { preferences, updatePreference } = usePreferences()
  const actions = preferences?.pushActions ?? [...DEFAULT_PUSH_ACTIONS]
  const reminderMinutes = preferences?.pushReminderMinutes ?? DEFAULT_PUSH_REMINDER_MINUTES
  const quickReaction = preferences?.pushQuickReaction ?? DEFAULT_PUSH_QUICK_REACTION
  const phone = useIsMobileOrCoarse()
  const unavailable = pushButtonsUnavailable(supportsNotificationActions(), level)
  const deviceOff = pushDevice !== "on" && pushDevice !== "subscribing"

  return (
    <SettingsDisclosure
      setting="push-buttons"
      summary={pushButtonsSummary(actions)}
      defaultOpen={!phone}
      inactive={unavailable?.reason}
      description={deviceOff ? `${settingDef("push-buttons").description} ${SHOWN_ONCE_DEVICE_ON}` : undefined}
    >
      <div className="space-y-3">
        <ul className="divide-y divide-border">
          {SLOT_LABELS.map((label, index) => (
            <SettingListItem key={label} label={label}>
              <Select
                value={actions[index] ?? NONE}
                onValueChange={(value) =>
                  updatePreference(
                    "pushActions",
                    assignSlot(actions, index, value === NONE ? null : (value as PushAction))
                  )
                }
              >
                <SelectTrigger aria-label={label} className={FIELD_CLASS}>
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
            </SettingListItem>
          ))}
          {actions.includes(PushActions.REMIND) && (
            <SettingListItem label="Remind me after">
              <Select
                value={String(reminderMinutes)}
                onValueChange={(value) => updatePreference("pushReminderMinutes", Number(value))}
              >
                <SelectTrigger aria-label="Remind me after" className={FIELD_CLASS}>
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
            </SettingListItem>
          )}
          {actions.includes(PushActions.REACT) && (
            <SettingListItem label={<span id="push-quick-reaction-label">Quick reaction</span>}>
              <ReactionEmojiPicker
                workspaceId={workspaceId}
                onSelect={(emoji) => updatePreference("pushQuickReaction", emoji)}
                trigger={
                  <button
                    type="button"
                    aria-label="Pick the quick reaction"
                    aria-describedby="push-quick-reaction-label"
                    className="flex size-11 items-center justify-center rounded-md border border-input text-lg hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 sm:size-9 [@media(pointer:coarse)]:size-11"
                  >
                    {quickReaction || <Smile aria-hidden className="h-4 w-4 text-muted-foreground" />}
                  </button>
                }
              />
            </SettingListItem>
          )}
        </ul>

        <NotificationPreview
          workspaceId={workspaceId}
          actions={actions}
          reminderMinutes={reminderMinutes}
          quickReaction={quickReaction}
        />
      </div>
    </SettingsDisclosure>
  )
}
