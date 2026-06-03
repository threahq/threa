import { ActivityTypes } from "@threa/types"

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
 * Format the notification body from the accumulated message list.
 * For a single message, returns a single line. For multiple, returns
 * newline-joined lines that OS notification centers can expand.
 */
export function formatBody(messages: NotificationMessage[]): string {
  return messages.map(formatLine).join("\n")
}
