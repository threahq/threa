/**
 * Bootstrap-time sweep of stale OS notifications.
 *
 * When a stream is read on another device while this device's app is closed,
 * nothing can dismiss the notification here: the backend deliberately sends no
 * "clear" push (a push that shows no notification burns the browser's
 * silent-push quota — Firefox revokes the subscription at 0), and the socket
 * fast-path (SW_MSG_CLEAR_NOTIFICATIONS in workspace-sync) only reaches open
 * apps. So on app open, once a fresh workspace bootstrap tells us what is
 * actually unread, we close every stream-tagged notification whose stream has
 * nothing unread left.
 */

/** Tags the SW owns that are NOT stream notification groups (never swept). */
const STREAM_TAG_PREFIX = "stream_"
const MENTION_TAG_SUFFIX = ":mention"

export interface DisplayedNotification {
  tag: string
  /** From the push payload the SW stamps on the notification (PushData.workspaceId). */
  workspaceId: string | undefined
}

/**
 * Which displayed notifications belong to streams of THIS workspace with
 * nothing unread? Only stream tags (`stream_…` and `stream_…:mention`) are
 * candidates — rewrap/session-expired/test tags have no unread backing and are
 * left alone. Notifications stamped with another workspace (or not stamped at
 * all) are never touched: the keep-set is per-workspace, so a foreign
 * workspace's unread stream would otherwise always look stale from here.
 */
export function selectStaleStreamTags(
  notifications: readonly DisplayedNotification[],
  workspaceId: string,
  unreadStreamIds: ReadonlySet<string>
): string[] {
  return notifications
    .filter((notification) => {
      if (notification.workspaceId !== workspaceId) return false
      const { tag } = notification
      const streamId = tag.endsWith(MENTION_TAG_SUFFIX) ? tag.slice(0, -MENTION_TAG_SUFFIX.length) : tag
      if (!streamId.startsWith(STREAM_TAG_PREFIX)) return false
      return !unreadStreamIds.has(streamId)
    })
    .map((notification) => notification.tag)
}

/** Close this workspace's displayed notifications for streams that are no longer unread. */
export async function sweepStaleStreamNotifications(
  workspaceId: string,
  unreadStreamIds: ReadonlySet<string>
): Promise<void> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return
  try {
    const registration = await navigator.serviceWorker.ready
    const notifications = await registration.getNotifications()
    const entries = notifications.map((notification) => ({
      tag: notification.tag,
      workspaceId: (notification.data as { workspaceId?: string } | null)?.workspaceId,
    }))
    // Closing by tag is workspace-safe: a tag is a stream id, and a stream
    // belongs to exactly one workspace.
    const stale = new Set(selectStaleStreamTags(entries, workspaceId, unreadStreamIds))
    for (const notification of notifications) {
      if (stale.has(notification.tag)) notification.close()
    }
  } catch {
    // Best-effort: a failed sweep leaves a stale banner, never breaks the app.
  }
}
