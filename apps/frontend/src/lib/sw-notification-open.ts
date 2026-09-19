/**
 * The worker's half of a notification tap: record where the tap should land,
 * then bring the app there.
 *
 * Every step of the handoff can fail on its own, so the destination is stashed
 * first (`notification-target-storage` explains what eats it) and nothing after
 * that is allowed to reject: a throw here kills the `notificationclick` handler
 * mid-flight — the badge never syncs and the tap does nothing at all.
 */

import { SW_MSG_NOTIFICATION_CLICK } from "./sw-messages"
import { stashNotificationTarget } from "./notification-target-storage"

interface FocusableClient {
  url: string
  focus(): Promise<unknown>
  postMessage(message: unknown): void
}

export interface NotificationClients {
  matchAll(options: { type: "window"; includeUncontrolled: boolean }): Promise<readonly FocusableClient[]>
  openWindow(url: string): Promise<unknown>
}

export async function openNotificationTarget(
  clients: NotificationClients,
  origin: string,
  targetUrl: string,
  workosUserId: string | undefined
): Promise<void> {
  await stashNotificationTarget({ url: targetUrl, workosUserId })
  try {
    // `includeUncontrolled`: a window loaded before this worker took control is
    // still the window the viewer is looking at.
    const windows = await clients.matchAll({ type: "window", includeUncontrolled: true })
    for (const client of windows) {
      if (new URL(client.url).origin !== origin) continue
      try {
        await client.focus()
      } catch {
        continue
      }
      client.postMessage({ type: SW_MSG_NOTIFICATION_CLICK, url: targetUrl, workosUserId })
      return
    }
    await clients.openWindow(new URL(targetUrl, origin).href)
  } catch (error) {
    // The window-interaction grant expires while an action's fetch runs, and
    // openWindow then rejects. The stash still lands the next app entry.
    console.warn("[SW] Could not bring the app to the notification's destination:", error)
  }
}
