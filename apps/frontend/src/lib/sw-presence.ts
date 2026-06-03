import { PRESENCE_INTERACTION_WINDOW_MS } from "@threa/types"

/**
 * Device-presence signal shared between the page and the service worker.
 *
 * The page records its most recent direct interaction (pointer/key/touch) into
 * a Cache entry; the service worker reads it when deciding whether to suppress a
 * push for the stream currently on screen. Cache Storage is shared across the
 * origin (window + worker) and survives the SW's frequent restarts, so this
 * needs no message round-trip and no in-memory state.
 *
 * "Present" uses PRESENCE_INTERACTION_WINDOW_MS — the same window the backend's
 * attended-device routing uses (features/push/service.ts) — so both layers
 * agree on what "present" means: a focused window only counts as actively
 * watched if it was interacted with within this window. A tab the user left
 * focused and walked away from ages out and stops suppressing notifications.
 */

/** Cache name holding the presence signal. Exported so the SW activate sweep keeps it. */
export const PRESENCE_CACHE = "threa-presence"
// Synthetic request key — never hits the network; just a stable Cache lookup key.
const PRESENCE_KEY = "https://threa.local/__presence__/last-interaction"

/** Pure: is `lastInteractionAt` within the presence window relative to `now`? */
export function isWithinPresenceWindow(lastInteractionAt: number | null, now: number): boolean {
  return lastInteractionAt !== null && now - lastInteractionAt < PRESENCE_INTERACTION_WINDOW_MS
}

/**
 * Record "the user just interacted with this device." Called by the page
 * (throttled). Best-effort: Cache Storage can be unavailable (private mode,
 * quota) — a failed write just means the SW won't see this interaction, which
 * fails open to showing notifications.
 */
export async function recordInteractionPresence(now: number = Date.now()): Promise<void> {
  try {
    const cache = await caches.open(PRESENCE_CACHE)
    await cache.put(PRESENCE_KEY, new Response(String(now)))
  } catch {
    // ignore — see doc comment
  }
}

/** Last-interaction timestamp (ms epoch), or null if never recorded or unreadable. */
async function readInteractionPresence(): Promise<number | null> {
  try {
    const cache = await caches.open(PRESENCE_CACHE)
    const res = await cache.match(PRESENCE_KEY)
    if (!res) return null
    const value = Number(await res.text())
    return Number.isFinite(value) ? value : null
  } catch {
    return null
  }
}

/**
 * True when this device saw a direct interaction within the presence window.
 * Read by the service worker to gate push suppression on recent activity rather
 * than focus alone. Fails open (false) when nothing was recorded or Cache
 * Storage is unreadable, so an error never silently swallows a notification.
 */
export async function isDevicePresent(now: number = Date.now()): Promise<boolean> {
  return isWithinPresenceWindow(await readInteractionPresence(), now)
}

export { PRESENCE_INTERACTION_WINDOW_MS }
