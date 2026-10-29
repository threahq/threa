import { useMemo } from "react"
import { StreamTypes, type StreamType, isOpenVisibility, streamTypeCapabilities } from "@threahq/types"
import {
  useWorkspaceStreams,
  useWorkspaceStreamMemberships,
  useWorkspaceUnreadState,
  type CachedStream,
} from "@/stores/workspace-store"
import { calculateUrgency } from "@/components/layout/sidebar/utils"
import { collectSealedStreamIds, isHiddenStreamType } from "@/lib/streams"
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
  /** Include doc hosts for flows that move docs; ordinary message/share pickers keep excluding them. */
  includeDocHosts?: boolean
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
  { search, sortMode, filter, includeDocHosts = false }: StreamPickerGroupsOptions
): Map<StreamType, SortableEntry<CachedStream>[]> {
  const streams = useWorkspaceStreams(workspaceId)
  const memberships = useWorkspaceStreamMemberships(workspaceId)
  const unreadState = useWorkspaceUnreadState(workspaceId)
  const unreadCounts = unreadState?.unreadCounts ?? EMPTY_COUNTS
  const mentionCounts = unreadState?.mentionCounts ?? EMPTY_COUNTS
  const activityCounts = unreadState?.activityCounts ?? EMPTY_COUNTS
  const mutedStreamIds = useMemo(() => new Set(unreadState?.mutedStreamIds ?? []), [unreadState?.mutedStreamIds])
  const sealedStreamIds = useMemo(() => collectSealedStreamIds(streams), [streams])

  const memberStreamIds = useMemo(() => {
    const ids = new Set<string>()
    for (const m of memberships) ids.add(m.streamId)
    return ids
  }, [memberships])

  return useMemo(() => {
    const lower = search.toLowerCase()
    const isSearching = lower.length > 0
    const streamsById = new Map(streams.map((stream) => [stream.id, stream]))

    const matchable = streams.filter((s) => {
      if (sealedStreamIds.has(s.id)) return false
      let accessStream = s
      if (s.type === StreamTypes.DOC) {
        if (!includeDocHosts) return false
        if (s.parentStreamId) {
          const root = s.rootStreamId ? streamsById.get(s.rootStreamId) : undefined
          if (!root) return false
          accessStream = root
        }
      } else {
        if (s.rootStreamId || s.type === StreamTypes.THREAD || isHiddenStreamType(s)) return false
        if (streamTypeCapabilities(s.type).messagesReadOnly) return false
      }
      const accessible = isOpenVisibility(accessStream.visibility) || memberStreamIds.has(accessStream.id)
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
  }, [
    streams,
    sealedStreamIds,
    memberStreamIds,
    search,
    sortMode,
    filter,
    includeDocHosts,
    unreadCounts,
    mentionCounts,
    activityCounts,
    mutedStreamIds,
  ])
}
