/**
 * The worker's half of a notification tap: record where the tap should land,
 * then bring the app there.
 *
 * Each step of the handoff can be lost on its own. `focus()` rejects on a
 * client the OS has frozen; `postMessage` has no ack, and a frozen page can be
 * foregrounded without ever reading it; a WebAPK relaunch can arrive at
 * `start_url` with the deep link dropped. Any of those leaves the viewer on
 * their restored last location instead of the stream they tapped, so the
 * destination is stashed first and the app claims it from there. A focus that
 * throws moves on to the next window and finally opens one, instead of killing
 * the handler, which is how a tap came to do nothing at all.
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
}
