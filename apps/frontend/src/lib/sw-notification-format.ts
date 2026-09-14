import {
  ActivityTypes,
  DEFAULT_PUSH_ACTIONS,
  DEFAULT_PUSH_QUICK_REACTION,
  DEFAULT_PUSH_REMINDER_MINUTES,
  PUSH_ACTIONS_MAX,
  PushActions,
  type PushAction,
} from "@threahq/types"

/** A single message entry accumulated by the service worker for grouped notifications. */
export interface NotificationMessage {
  authorName?: string
  contentPreview?: string
  /** Set for reaction entries — the emoji the actor reacted with. Renders a distinct line. */
  emoji?: string
}

/** Max messages to keep in a grouped notification's rolling history. */
const MAX_MESSAGES = 5

/** Max characters per content preview line to stay within OS notification body limits. */
const MAX_PREVIEW_CHARS = 80

/**
 * Append a new message to the rolling history, capping at MAX_MESSAGES.
 * Returns the new array (does not mutate the input).
 */
export function appendMessage(existing: NotificationMessage[], incoming: NotificationMessage): NotificationMessage[] {
  const updated = [...existing, incoming]
  if (updated.length > MAX_MESSAGES) {
    return updated.slice(updated.length - MAX_MESSAGES)
  }
  return updated
}

/**
 * Parse a Threa stream-view URL into its workspace + stream ids, or null when
 * the URL isn't a stream view. The route is `/w/{workspaceId}/s/{streamId}`;
 * an open thread is a `?m=…` query (not a path segment), so it still resolves
 * to the underlying stream. Non-stream surfaces (sidebar root, settings,
 * activity, saved) return null and never match.
 */
function parseStreamRoute(url: string): { workspaceId: string; streamId: string } | null {
  let pathname: string
  try {
    pathname = new URL(url).pathname
  } catch {
    return null
  }
  const match = pathname.match(/^\/w\/([^/]+)\/s\/([^/]+)/)
  if (!match) return null
  return { workspaceId: match[1], streamId: match[2] }
}

/**
 * True when `url` is a window already viewing the given stream. Used by the
 * service worker to suppress a push the user can already see: a push for the
 * stream on screen is dropped, but a push for any *other* stream (or a
 * non-stream view) still surfaces even while the app is focused. Absent ids
 * never match — we can't confirm the view, so we err toward showing.
 */
export function isViewingStream(url: string, workspaceId: string | undefined, streamId: string | undefined): boolean {
  if (!workspaceId || !streamId) return false
  const route = parseStreamRoute(url)
  return route !== null && route.workspaceId === workspaceId && route.streamId === streamId
}

/** Resolve the notification tag — mentions get a distinct tag so they stay visually separate. */
export function resolveTag(streamId: string, activityType?: string): string {
  if (activityType === ActivityTypes.MENTION) {
    return `${streamId}:mention`
  }
  return streamId
}

/** Format the notification title based on message count, stream name, and activity type. */
export function formatTitle(messages: NotificationMessage[], streamName?: string, activityType?: string): string {
  const count = messages.length
  const isMention = activityType === ActivityTypes.MENTION

  if (count === 1) {
    if (isMention) {
      return streamName ? `Mentioned in ${streamName}` : "You were mentioned"
    }
    return streamName ?? "New message"
  }

  if (isMention) {
    return streamName ? `${count} new mentions in ${streamName}` : `${count} new mentions`
  }
  return streamName ? `${streamName} · ${count} new messages` : `${count} new messages`
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text
  return text.slice(0, maxLen - 1) + "…"
}

/**
 * Format a single line. Reactions read "Alice reacted 👍 to "preview…"" so they
 * are unmistakably a reaction, not a new message; plain messages stay "Alice: preview…".
 */
function formatLine(msg: NotificationMessage): string {
  const preview = msg.contentPreview ? truncate(msg.contentPreview, MAX_PREVIEW_CHARS) : ""
  if (msg.emoji) {
    const who = msg.authorName ?? "Someone"
    return preview ? `${who} reacted ${msg.emoji} to "${preview}"` : `${who} reacted ${msg.emoji}`
  }
  if (msg.authorName) {
    return preview ? `${msg.authorName}: ${preview}` : msg.authorName
  }
  return preview || "New message"
}

/**
 * Format the notification body from the accumulated message list, newest
 * first. Collapsed OS banners show only the first body line, so the line the
 * user sees without expanding must be the message that just arrived; the
 * older entries follow for the expanded view.
 */
export function formatBody(messages: NotificationMessage[]): string {
  return messages.map(formatLine).reverse().join("\n")
}

export interface NotificationActionButton {
  action: PushAction
  title: string
}

export interface NotificationActionPrefs {
  pushActions?: PushAction[]
  pushReminderMinutes?: number
  pushQuickReaction?: string
}

function actionTitle(action: PushAction, prefs: NotificationActionPrefs): string {
  switch (action) {
    case PushActions.MARK_READ:
      return "Mark read"
    case PushActions.REMIND:
      return `Remind me in ${formatReminderDelay(prefs.pushReminderMinutes ?? DEFAULT_PUSH_REMINDER_MINUTES)}`
    case PushActions.REACT:
      return prefs.pushQuickReaction ?? DEFAULT_PUSH_QUICK_REACTION
  }
}

/** "5m", "2h", "3d": the button label has room for little more. */
export function formatReminderDelay(minutes: number): string {
  if (minutes % (24 * 60) === 0) return `${minutes / (24 * 60)}d`
  if (minutes % 60 === 0) return `${minutes / 60}h`
  return `${minutes}m`
}

/**
 * Buttons for a message notification, from the user's preferences (default
 * Mark read + Remind me). A reaction push points at the reader's own message,
 * so reacting back is nonsense and that slot is dropped. Chrome renders
 * these; iOS Safari ignores `actions` entirely.
 */
export function resolveActions(
  activityType: string | undefined,
  prefs: NotificationActionPrefs
): NotificationActionButton[] {
  const actions = (prefs.pushActions ?? DEFAULT_PUSH_ACTIONS).slice(0, PUSH_ACTIONS_MAX)
  return actions
    .filter((action) => !(action === PushActions.REACT && activityType === ActivityTypes.REACTION))
    .map((action) => ({ action, title: actionTitle(action, prefs) }))
}

export interface NotificationActionTarget extends NotificationActionPrefs {
  workspaceId?: string
  streamId?: string
  /** Deep-link target: the oldest message of a grouped card. */
  messageId?: string
  /** The message that arrived last, what an action button should act on. */
  latestMessageId?: string
}

/**
 * The message an action button acts on after this push joins the card. A
 * reaction push carries the reader's own older message, so it must not pull
 * the pointer back behind a newer message already on the card.
 */
export function resolveLatestMessageId(
  previous: { latestMessageId?: string; messageId?: string } | undefined,
  incoming: { activityType?: string; messageId?: string }
): string | undefined {
  const current = previous?.latestMessageId ?? previous?.messageId
  if (incoming.activityType === ActivityTypes.REACTION) return current ?? incoming.messageId
  return incoming.messageId ?? current
}

export interface NotificationActionRequest {
  url: string
  body: Record<string, string>
}

/**
 * The API call behind an action button, or null when the notification lacks
 * the ids to make one (the caller then opens the app instead). All act on the
 * newest message of the card: reading through it clears the whole group, a
 * quick reaction answers what the banner showed, a reminder brings it back.
 */
export function planNotificationAction(
  action: string,
  data: NotificationActionTarget,
  now: number = Date.now()
): NotificationActionRequest | null {
  const messageId = data.latestMessageId ?? data.messageId
  if (!data.workspaceId || !messageId) return null
  switch (action) {
    case PushActions.MARK_READ:
      if (!data.streamId) return null
      return {
        url: `/api/workspaces/${data.workspaceId}/streams/${data.streamId}/read`,
        body: { lastEventId: messageId },
      }
    case PushActions.REACT:
      return {
        url: `/api/workspaces/${data.workspaceId}/messages/${messageId}/reactions`,
        body: { emoji: data.pushQuickReaction ?? DEFAULT_PUSH_QUICK_REACTION },
      }
    case PushActions.REMIND: {
      const minutes = data.pushReminderMinutes ?? DEFAULT_PUSH_REMINDER_MINUTES
      return {
        url: `/api/workspaces/${data.workspaceId}/saved`,
        body: { messageId, remindAt: new Date(now + minutes * 60_000).toISOString() },
      }
    }
    default:
      return null
  }
}

/**
 * Messages represented by the notifications currently in the shade — the app
 * icon badge. Only message cards carry `messages`; rings, reminders and the
 * session-expired card count for nothing.
 */
export function countNotifiedMessages(notificationData: Array<{ messages?: unknown[] } | undefined>): number {
  return notificationData.reduce((total, data) => total + (data?.messages?.length ?? 0), 0)
}
