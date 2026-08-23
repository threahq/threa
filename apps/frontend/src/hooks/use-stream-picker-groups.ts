import { useMemo } from "react"
import { StreamTypes, Visibilities, type StreamType } from "@threa/types"
import {
  useWorkspaceStreams,
  useWorkspaceStreamMemberships,
  useWorkspaceUnreadState,
  type CachedStream,
} from "@/stores/workspace-store"
import { calculateUrgency } from "@/components/layout/sidebar/utils"
import { isHiddenStreamType } from "@/lib/streams"
import { scoreStreamMatch, compareStreamEntries, type SortableEntry, type StreamSortMode } from "@/lib/stream-sort"

/** Stable identity for the no-unread-state case so the memo doesn't re-sort every render. */
const EMPTY_COUNTS: Record<string, number> = Object.freeze({}) as Record<string, number>

export interface StreamPickerGroupsOptions {
  /** Lowercased or raw search text; empty string means "browsing". */
  search: string
  sortMode: StreamSortMode
  /**
   * Extra predicate applied ON TOP of the baseline access filter
   * (public-or-member, not archived, not a thread/system/aside stream). Lets a caller
   * narrow to postable channels+DMs while another caller keeps scratchpads.
   */
  filter?: (stream: CachedStream) => boolean
}

/**
 * The shared filter → enrich → group → sort pipeline behind every stream picker
 * (share modal, overlay composer target picker). Reads the workspace caches once
 * and returns accessible streams grouped by type, each group ordered by
 * {@link compareStreamEntries} (recency/urgency when browsing, score when
 * searching). Callers decide which type groups to render and in what order.
 *
 * Extracted so pickers stop re-deriving the access filter + urgency enrichment
 * by hand — the recurring drift point (INV-35/37).
 */
export function useStreamPickerGroups(
  workspaceId: string,
  { search, sortMode, filter }: StreamPickerGroupsOptions
): Map<StreamType, SortableEntry<CachedStream>[]> {
  const streams = useWorkspaceStreams(workspaceId)
  const memberships = useWorkspaceStreamMemberships(workspaceId)
  const unreadState = useWorkspaceUnreadState(workspaceId)
  const unreadCounts = unreadState?.unreadCounts ?? EMPTY_COUNTS
  const mentionCounts = unreadState?.mentionCounts ?? EMPTY_COUNTS
  const activityCounts = unreadState?.activityCounts ?? EMPTY_COUNTS
  const mutedStreamIds = useMemo(() => new Set(unreadState?.mutedStreamIds ?? []), [unreadState?.mutedStreamIds])

  const memberStreamIds = useMemo(() => {
    const ids = new Set<string>()
    for (const m of memberships) ids.add(m.streamId)
    return ids
  }, [memberships])

  return useMemo(() => {
    const lower = search.toLowerCase()
    const isSearching = lower.length > 0

    const matchable = streams.filter((s) => {
      if (s.archivedAt) return false
      if (s.rootStreamId) return false
      if (s.type === StreamTypes.THREAD || s.type === StreamTypes.SYSTEM || isHiddenStreamType(s)) return false
      const accessible = s.visibility === Visibilities.PUBLIC || memberStreamIds.has(s.id)
      if (!accessible) return false
      return filter ? filter(s) : true
    })

    const enriched = matchable
      .map((stream) => {
        const unreadCount = unreadCounts[stream.id] ?? 0
        const mentionCount = mentionCounts[stream.id] ?? 0
        const activityCount = activityCounts[stream.id] ?? 0
        const isMuted = mutedStreamIds.has(stream.id)
        const urgency = calculateUrgency(stream, unreadCount, mentionCount, isMuted, activityCount)
        return { stream, score: scoreStreamMatch(stream, lower), urgency }
      })
      .filter(({ score }) => score !== Infinity)

    const byType = new Map<StreamType, SortableEntry<CachedStream>[]>()
    for (const entry of enriched) {
      const list = byType.get(entry.stream.type) ?? []
      list.push(entry)
      byType.set(entry.stream.type, list)
    }
    for (const [, list] of byType) {
      list.sort((a, b) => compareStreamEntries(a, b, { isSearching, mode: sortMode }))
    }
    return byType
  }, [streams, memberStreamIds, search, sortMode, filter, unreadCounts, mentionCounts, activityCounts, mutedStreamIds])
}
