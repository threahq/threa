/**
 * Device-presence signal shared between the page and the service worker.
 *
 * The page records its most recent direct interaction (pointer/key/touch) into
 * a Cache entry; the service worker reads it when deciding whether to suppress a
 * push for the stream currently on screen. Cache Storage is shared across the
 * origin (window + worker) and survives the SW's frequent restarts, so this
 * needs no message round-trip and no in-memory state.
 *
 * "Present" deliberately mirrors the backend's attended-device rule
 * (RECENT_INTERACTION_WINDOW_MS in features/push/service.ts): a focused window
 * only counts as actively watched if it was interacted with within this window.
 * A tab the user left focused and walked away from ages out and stops
 * suppressing notifications — so both layers agree on what "present" means.
 */
export const PRESENCE_INTERACTION_WINDOW_MS = 2 * 60_000

/** Pure: is `lastInteractionAt` within the presence window relative to `now`? */
export function isWithinPresenceWindow(lastInteractionAt: number | null, now: number): boolean {
  return lastInteractionAt !== null && now - lastInteractionAt < PRESENCE_INTERACTION_WINDOW_MS
}

const PRESENCE_CACHE = "threa-presence"
// Synthetic request key — never hits the network; just a stable Cache lookup key.
const PRESENCE_KEY = "https://threa.local/__presence__/last-interaction"

/** Record "the user just interacted with this device." Called by the page (throttled). */
export async function recordInteractionPresence(now: number = Date.now()): Promise<void> {
  const cache = await caches.open(PRESENCE_CACHE)
  await cache.put(PRESENCE_KEY, new Response(String(now)))
}

/** Last-interaction timestamp (ms epoch), or null if never recorded. */
async function readInteractionPresence(): Promise<number | null> {
  const cache = await caches.open(PRESENCE_CACHE)
  const res = await cache.match(PRESENCE_KEY)
  if (!res) return null
  const value = Number(await res.text())
  return Number.isFinite(value) ? value : null
}

/**
 * True when this device saw a direct interaction within the presence window.
 * Read by the service worker to gate push suppression on recent activity rather
 * than focus alone. Fails open (false) when nothing was ever recorded.
 */
export async function isDevicePresent(now: number = Date.now()): Promise<boolean> {
  return isWithinPresenceWindow(await readInteractionPresence(), now)
}
