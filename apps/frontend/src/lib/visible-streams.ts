import { PRESENCE_CACHE } from "./sw-presence"

/**
 * Which streams are actually on screen right now — the page-side half of push
 * suppression, shared with the service worker via Cache Storage (same
 * mechanism and cache as the interaction-presence signal in sw-presence.ts).
 *
 * The SW can't derive this from window URLs alone: threads and conversations
 * open as `?panel=` params on whatever route is current, and a conversation
 * panel's underlying stream ids aren't in the URL at all. So the surfaces that
 * render a stream register their ids here, and the SW checks membership when
 * deciding whether a push is for something the user can already see.
 *
 * The cache entry is last-writer-wins across tabs, so it carries a strict
 * ownership rule (enforced in use-visible-streams.ts): only the focused tab
 * ever writes it, and every focus gain re-publishes. That makes the entry
 * "what the focused Threa tab is viewing" by construction — a background tab
 * can't clobber it, and after a tab closes without cleanup the entry is
 * rewritten the moment any Threa tab gains focus. No TTL: while no Threa tab
 * is focused, the SW's focused-client gate (plus the isDevicePresent
 * interaction window) keeps a stale entry inert; while one is focused, the
 * entry is that tab's own set.
 */

// Synthetic request key — never hits the network; a stable Cache lookup key.
const VISIBLE_STREAMS_KEY = "https://threa.local/__presence__/visible-streams"

export interface VisibleStreamRegistry {
  /** Register stream ids as visible; returns an unregister function. Refcounted. */
  register(streamIds: readonly string[]): () => void
  /** Re-publish the current set (e.g. when this tab regains focus). */
  republish(): void
  snapshot(): string[]
}

/**
 * Refcounted registry of on-screen stream ids. Publishes the deduped set via
 * `publish` on every change, coalesced to one call per microtask so a panel
 * swap (unregister + register in one render) publishes once.
 */
export function createVisibleStreamRegistry(publish: (streamIds: string[]) => void): VisibleStreamRegistry {
  const counts = new Map<string, number>()
  let queued = false

  const flush = () => {
    queued = false
    publish([...counts.keys()].sort())
  }
  const schedule = () => {
    if (queued) return
    queued = true
    queueMicrotask(flush)
  }

  return {
    register(streamIds: readonly string[]): () => void {
      for (const id of streamIds) counts.set(id, (counts.get(id) ?? 0) + 1)
      schedule()
      let released = false
      return () => {
        if (released) return
        released = true
        for (const id of streamIds) {
          const next = (counts.get(id) ?? 1) - 1
          if (next <= 0) counts.delete(id)
          else counts.set(id, next)
        }
        schedule()
      }
    },
    republish: schedule,
    snapshot: () => [...counts.keys()].sort(),
  }
}

/** Best-effort write; a failure just means the SW falls back to URL matching. */
export async function publishVisibleStreams(streamIds: string[]): Promise<void> {
  try {
    const cache = await caches.open(PRESENCE_CACHE)
    await cache.put(VISIBLE_STREAMS_KEY, new Response(JSON.stringify(streamIds)))
  } catch {
    // ignore — fails open to showing notifications
  }
}

/** Read by the service worker. Empty set on missing/malformed/unreadable entry. */
export async function readVisibleStreams(): Promise<ReadonlySet<string>> {
  try {
    const cache = await caches.open(PRESENCE_CACHE)
    const res = await cache.match(VISIBLE_STREAMS_KEY)
    if (!res) return new Set()
    const parsed = (await res.json()) as unknown
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((value): value is string => typeof value === "string"))
  } catch {
    return new Set()
  }
}
