import { useCallback, useState } from "react"
import type { Stream } from "@threa/types"
import type { UrgencyLevel } from "@/components/layout/sidebar/types"
import { getActivityTime } from "@/components/layout/sidebar/utils"
import { streamLabel } from "@/lib/streams"

/** Sort modes used by stream pickers (quick switcher, share modal, share picker). */
export type StreamSortMode = "recency" | "alphabetical"

/** Urgency priority for sorting: mentions > ai > activity > bot > quiet (lower wins). */
export const URGENCY_ORDER: Record<UrgencyLevel, number> = { mentions: 0, ai: 1, activity: 2, bot: 3, quiet: 4 }

/** Minimal shape pickers need for sorting — name lookup + activity time. */
export type SortableStream = Pick<Stream, "id" | "type" | "createdAt"> & {
  displayName?: string | null
  slug?: string | null
  lastMessagePreview?: { createdAt: string } | null
}

/**
 * Score a stream against a lowercased query. Lower = better match.
 * Returns Infinity for non-matches. Mirrors the quick-switcher heuristic so
 * search results land in the same order across every picker surface.
 */
export function scoreStreamMatch(
  stream: Pick<Stream, "id" | "type" | "displayName" | "slug">,
  lowerQuery: string
): number {
  if (!lowerQuery) return 0
  const name = streamLabel(stream).toLowerCase()
  if (name === lowerQuery) return 0
  if (name.startsWith(lowerQuery)) return 1
  if (name.includes(lowerQuery)) return 2
  if (stream.id.toLowerCase().includes(lowerQuery)) return 3
  return Infinity
}

function compareNames(a: SortableStream, b: SortableStream): number {
  const aName = streamLabel(a)
  const bName = streamLabel(b)
  return aName.localeCompare(bName)
}

export interface SortableEntry<S extends SortableStream> {
  stream: S
  /** Match score from scoreStreamMatch; ignored when not searching. */
  score: number
  /** Pre-computed urgency level for this stream. */
  urgency: UrgencyLevel
}

/**
 * Comparator for stream picker entries. Mirrors the quick-switcher behavior so
 * the share dialog and share-target picker stay visually aligned with it.
 *
 *   - searching:         score → alphabetical (mode is ignored)
 *   - browsing/recency:  urgency → activity time → alphabetical
 *   - browsing/alpha:    alphabetical
 */
export function compareStreamEntries<S extends SortableStream>(
  a: SortableEntry<S>,
  b: SortableEntry<S>,
  options: { isSearching: boolean; mode: StreamSortMode }
): number {
  if (options.isSearching) {
    if (a.score !== b.score) return a.score - b.score
    return compareNames(a.stream, b.stream)
  }
  if (options.mode === "alphabetical") {
    return compareNames(a.stream, b.stream)
  }
  const urgencyDiff = URGENCY_ORDER[a.urgency] - URGENCY_ORDER[b.urgency]
  if (urgencyDiff !== 0) return urgencyDiff
  const timeDiff = getActivityTime(b.stream) - getActivityTime(a.stream)
  if (timeDiff !== 0) return timeDiff
  return compareNames(a.stream, b.stream)
}

const SORT_PREFERENCE_KEY = "threa-stream-picker-sort"

/** Persisted picker sort preference. Falls back to "recency" when absent or invalid. */
export function readStoredStreamSortMode(): StreamSortMode {
  try {
    const value = localStorage.getItem(SORT_PREFERENCE_KEY)
    return value === "alphabetical" ? "alphabetical" : "recency"
  } catch {
    return "recency"
  }
}

export function writeStoredStreamSortMode(mode: StreamSortMode): void {
  try {
    localStorage.setItem(SORT_PREFERENCE_KEY, mode)
  } catch {
    // Storage unavailable
  }
}

/**
 * Hook for stream pickers (share modal, share-target page) that owns the
 * sort-mode state and its localStorage persistence in one place. Keeps the
 * caller free of direct storage access (INV-15) and avoids duplicating the
 * useState + useEffect pair across surfaces.
 */
export function useStoredStreamSortMode(): [StreamSortMode, (next: StreamSortMode) => void] {
  const [sortMode, setSortModeState] = useState<StreamSortMode>(() => readStoredStreamSortMode())
  const setSortMode = useCallback((next: StreamSortMode) => {
    setSortModeState(next)
    writeStoredStreamSortMode(next)
  }, [])
  return [sortMode, setSortMode]
}
