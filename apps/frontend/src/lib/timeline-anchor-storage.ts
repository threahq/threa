/**
 * Persists the timeline scroll anchor of a reader who detached from the live
 * tail, so a reload lands them back on the row they were reading instead of
 * snapping to the bottom. One entry per stream: the topmost visible row's id
 * (message or event id) and its offset from the scroller's viewport top —
 * negative when the reader is midway through a row taller than the viewport.
 *
 * localStorage rather than sessionStorage: the mobile PWA reload that
 * motivated this often opens a fresh browsing session. Entries expire after
 * ANCHOR_TTL_MS and the map is capped with the oldest evicted first, so
 * abandoned streams don't accumulate. Following the live tail clears the
 * stream's entry — the tail is the default landing, so only detachment is
 * worth remembering.
 */

const STORAGE_KEY = "threa:timeline-anchors"
const ANCHOR_TTL_MS = 12 * 60 * 60 * 1000
const MAX_ENTRIES = 50

export interface TimelineAnchor {
  /** `data-message-id` / `data-event-id` of the topmost visible row. */
  targetId: string
  /** px from the scroller's viewport top to the row's top (can be negative). */
  offsetPx: number
}

interface StoredAnchor extends TimelineAnchor {
  at: number
}

function readAll(): Record<string, StoredAnchor> {
  if (typeof localStorage === "undefined") return {}
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {}
    return parsed as Record<string, StoredAnchor>
  } catch {
    return {}
  }
}

function writeAll(map: Record<string, StoredAnchor>): void {
  if (typeof localStorage === "undefined") return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
  } catch {
    // Storage quota / private-mode failures must not break scrolling.
  }
}

export function saveTimelineAnchor(streamId: string, anchor: TimelineAnchor): void {
  const map = readAll()
  map[streamId] = { ...anchor, at: Date.now() }
  const ids = Object.keys(map)
  if (ids.length > MAX_ENTRIES) {
    ids.sort((a, b) => (map[a]?.at ?? 0) - (map[b]?.at ?? 0))
    for (const id of ids.slice(0, ids.length - MAX_ENTRIES)) delete map[id]
  }
  writeAll(map)
}

export function loadTimelineAnchor(streamId: string): TimelineAnchor | null {
  const entry = readAll()[streamId]
  if (!entry) return null
  if (typeof entry.targetId !== "string" || !Number.isFinite(entry.offsetPx) || !Number.isFinite(entry.at)) return null
  if (Date.now() - entry.at > ANCHOR_TTL_MS) return null
  return { targetId: entry.targetId, offsetPx: entry.offsetPx }
}

export function clearTimelineAnchor(streamId: string): void {
  const map = readAll()
  if (!(streamId in map)) return
  delete map[streamId]
  writeAll(map)
}
