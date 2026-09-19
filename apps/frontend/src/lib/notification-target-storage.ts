/**
 * Durable handoff for a notification tap's destination.
 *
 * `postMessage` from `notificationclick` is fire-and-forget: a frozen page can
 * be brought to the foreground by the OS without ever processing it, and a
 * relaunch can arrive at `start_url` with the deep link dropped — both land the
 * viewer on the restored last location instead of the stream they tapped. The
 * worker therefore writes the destination here before it focuses or opens a
 * window, and every entry point into the app claims it: the SW message, boot,
 * and the return-to-foreground transition.
 *
 * A read deletes the entry, and one older than {@link NOTIFICATION_TARGET_TTL_MS}
 * reads as absent so a tap can never redirect a later, deliberate visit.
 * CacheStorage has no compare-and-delete, so two overlapping reads can still see
 * the same entry: `createNotificationLanding` in `notification-landing.ts` is
 * what runs the three entry points one at a time.
 */

import { NOTIFICATION_TARGET_CACHE } from "./sw-messages"

const TARGET_KEY = "/_notify/target"

const RESOLUTION_BASE = "https://notification-target.invalid"

/**
 * A path this app can navigate to. Resolved rather than pattern-matched: `//host`
 * and `/\host` are both protocol-relative for a special scheme, so a prefix test
 * reads one of them as local.
 */
export function isSameOriginPath(url: string): boolean {
  return url.startsWith("/") && new URL(url, RESOLUTION_BASE).origin === RESOLUTION_BASE
}

export interface NotificationTarget {
  /** Same-origin path the tap should land on. */
  url: string
  /** Recipient account, so a tap under a parked account flips identity first. */
  workosUserId?: string
}

/**
 * A tap the app has not claimed within a minute was consumed some other way
 * (the SW message landed, or the launch carried the URL). Redirecting after
 * that would move a viewer who is already reading something else.
 */
export const NOTIFICATION_TARGET_TTL_MS = 60_000

export async function stashNotificationTarget(target: NotificationTarget, now: number = Date.now()): Promise<void> {
  try {
    const cache = await caches.open(NOTIFICATION_TARGET_CACHE)
    await cache.put(TARGET_KEY, new Response(JSON.stringify({ ...target, at: now })))
  } catch (error) {
    console.warn("[notify] Could not stash the notification's destination:", error)
  }
}

/** Read and remove the stashed target, or null when there is none or it is stale. */
export async function takeNotificationTarget(now: number = Date.now()): Promise<NotificationTarget | null> {
  try {
    const cache = await caches.open(NOTIFICATION_TARGET_CACHE)
    const response = await cache.match(TARGET_KEY)
    if (!response) return null
    await cache.delete(TARGET_KEY)
    const raw = (await response.json()) as Partial<NotificationTarget> & { at?: unknown }
    if (!raw || typeof raw.url !== "string" || !isSameOriginPath(raw.url)) return null
    if (typeof raw.at !== "number" || now - raw.at > NOTIFICATION_TARGET_TTL_MS) return null
    return {
      url: raw.url,
      workosUserId: typeof raw.workosUserId === "string" ? raw.workosUserId : undefined,
    }
  } catch (error) {
    console.warn("[notify] Could not read the stashed notification destination:", error)
    return null
  }
}
