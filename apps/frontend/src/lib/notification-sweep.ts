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

/**
 * Which of the displayed notification tags belong to streams with nothing
 * unread? Only stream tags (`stream_…` and `stream_…:mention`) are candidates —
 * rewrap/session-expired/test tags have no unread backing and are left alone.
 */
export function selectStaleStreamTags(tags: readonly string[], unreadStreamIds: ReadonlySet<string>): string[] {
  return tags.filter((tag) => {
    const streamId = tag.endsWith(MENTION_TAG_SUFFIX) ? tag.slice(0, -MENTION_TAG_SUFFIX.length) : tag
    if (!streamId.startsWith(STREAM_TAG_PREFIX)) return false
    return !unreadStreamIds.has(streamId)
  })
}

/** Close displayed notifications for streams that are no longer unread. */
export async function sweepStaleStreamNotifications(unreadStreamIds: ReadonlySet<string>): Promise<void> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return
  try {
    const registration = await navigator.serviceWorker.ready
    const notifications = await registration.getNotifications()
    const stale = new Set(
      selectStaleStreamTags(
        notifications.map((n) => n.tag),
        unreadStreamIds
      )
    )
    for (const notification of notifications) {
      if (stale.has(notification.tag)) notification.close()
    }
  } catch {
    // Best-effort: a failed sweep leaves a stale banner, never breaks the app.
  }
}
