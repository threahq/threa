import { useState, useMemo, useCallback } from "react"
import { useQuery } from "@tanstack/react-query"
import { Hash, Plus, X, Archive } from "lucide-react"
import { StreamTypes, draftStreamScope, getAvatarUrl } from "@threahq/types"
import type { Stream, StreamType } from "@threahq/types"
import { getStreamName, streamLabel, STREAM_ICONS } from "@/lib/streams"
import { streamsApi } from "@/api"
import { createDmDraftId, useUnreadCounts, useActivityCounts } from "@/hooks"
import { useWorkspaceUnreadState } from "@/stores/workspace-store"
import { openAside } from "@/stores/aside-store"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { calculateUrgency } from "@/components/layout/sidebar/utils"
import { isToleranceMatch, scoreMatch } from "@/lib/match-score"
import { compareStreamEntries, scoreStreamMatch } from "@/lib/stream-sort"
import { FILTER_TYPE_OPTIONS } from "@/components/editor/triggers/filter-type-extension"
import { FilterSelect } from "./filter-select"
import {
  parseSearchQuery,
  removeFilterFromQuery,
  addFilterToQuery,
  getFilterLabel,
  type FilterType,
} from "@/lib/search-query-parser"
import type { ModeContext, ModeResult, QuickSwitcherItem, WorkspaceStream } from "./types"

const FILTER_TYPES: { type: FilterType; label: string; icon: React.ReactNode }[] = [
  { type: "type", label: "Stream type", icon: <Hash className="h-4 w-4" /> },
  { type: "status", label: "Status", icon: <Archive className="h-4 w-4" /> },
]

const STREAM_TYPE_OPTIONS: { value: StreamType; label: string }[] = FILTER_TYPE_OPTIONS.map(({ value, label }) => ({
  value,
  label,
}))

const ARCHIVE_STATUS_OPTIONS: { value: "active" | "archived"; label: string }[] = [
  { value: "active", label: "Active" },
  { value: "archived", label: "Archived" },
]

/** Stream with optional sidebar preview (CachedStream has it, API Stream doesn't) */
type StreamLike = Stream & { lastMessagePreview?: WorkspaceStream["lastMessagePreview"] }

function getStreamTypeLabel(type: StreamType): string {
  switch (type) {
    case StreamTypes.SCRATCHPAD:
      return "Scratchpad"
    case StreamTypes.CHANNEL:
      return "Channel"
    case StreamTypes.DM:
      return "Direct Message"
    case StreamTypes.SYSTEM:
      return "System"
    case StreamTypes.THREAD:
      return "Thread"
    case StreamTypes.ASIDE:
      return "Aside"
    default:
      return type
  }
}

export function useStreamItems(context: ModeContext): ModeResult {
  const {
    streams: activeStreams,
    streamMemberships,
    users,
    currentUserId,
    dmPeers,
    query,
    onQueryChange,
    workspaceId,
    navigate,
    closeDialog,
  } = context

  const { getUnreadCount } = useUnreadCounts(workspaceId)
  const { getMentionCount, getActivityCount } = useActivityCounts(workspaceId)
  const unreadState = useWorkspaceUnreadState(workspaceId)
  const mutedStreamIds = useMemo(() => new Set(unreadState?.mutedStreamIds ?? []), [unreadState?.mutedStreamIds])

  const memberStreamIds = useMemo(() => {
    const ids = new Set<string>()
    for (const m of streamMemberships) ids.add(m.streamId)
    return ids
  }, [streamMemberships])

  const [addingFilter, setAddingFilter] = useState<FilterType | null>(null)

  // Query string is the single source of truth for active filters.
  const { filters: parsedFilters, text: searchText } = useMemo(() => parseSearchQuery(query), [query])

  const statusFilters = useMemo(
    () => parsedFilters.filter((f) => f.type === "status").map((f) => f.value as "active" | "archived"),
    [parsedFilters]
  )

  const typeFilters = useMemo(
    () => parsedFilters.filter((f) => f.type === "type").map((f) => f.value as StreamType),
    [parsedFilters]
  )

  const showArchived = statusFilters.includes("archived")
  const showActive = statusFilters.length === 0 || statusFilters.includes("active")

  const { data: archivedStreams, isLoading: isLoadingArchived } = useQuery({
    queryKey: ["streams", workspaceId, "archived"],
    queryFn: () => streamsApi.list(workspaceId, { status: ["archived"] }),
    enabled: showArchived,
    staleTime: 30_000,
  })

  const handleAddFilter = (type: FilterType) => {
    setAddingFilter(type)
  }

  const handleFilterSelect = (value: string, _label: string) => {
    if (!addingFilter) return
    const newQuery = addFilterToQuery(query, addingFilter, value)
    // Add trailing space so cursor moves out of the filter, closing any popovers
    onQueryChange(newQuery + " ")
    setAddingFilter(null)
  }

  const handleRemoveFilter = (index: number) => {
    const newQuery = removeFilterFromQuery(query, index)
    onQueryChange(newQuery)
  }

  const closeFilterSelect = useCallback(() => {
    setAddingFilter(null)
  }, [])

  const getFilterIcon = (type: FilterType) => {
    const filterType = FILTER_TYPES.find((f) => f.type === type)
    return filterType?.icon ?? null
  }

  const items = useMemo(() => {
    const lowerQuery = searchText.toLowerCase()
    const usersById = new Map((users ?? []).map((workspaceUser) => [workspaceUser.id, workspaceUser]))
    const dmPeerByStreamId = new Map((dmPeers ?? []).map((peer) => [peer.streamId, peer.userId]))
    // A thread rooted in someone else's aside is reachable but not listable —
    // the aside itself never lists, and its threads inherit that.
    const hiddenRootIds = new Set(
      activeStreams.filter((s) => s.type === StreamTypes.ASIDE && s.createdBy !== currentUserId).map((s) => s.id)
    )

    // Active streams are CachedStream (with lastMessagePreview), archived come from API as Stream.
    // The stream cache durably holds archived rows (archived-stream index), so
    // the active palette must exclude them — archived is its own gated surface
    // below, and letting both in would double-list every archived stream.
    const allStreams: StreamLike[] = [
      ...(showActive ? activeStreams.filter((s) => !s.archivedAt) : []),
      ...(showArchived && archivedStreams ? archivedStreams : []),
    ]

    const isSearching = searchText.length > 0

    // Threads are the workspace's long tail — one per reply chain — so they join
    // the list only once something narrows it: a query, or `is:thread`. Browsing
    // an unnarrowed palette is a list of the streams you navigate BETWEEN.
    const wantsThreads = isSearching || typeFilters.includes(StreamTypes.THREAD)
    // An unnamed thread has no text to match: `streamLabel` would hand every one
    // of them the placeholder "Thread" and the query `thre` would return the lot.
    const isSearchableThread = (s: StreamLike) =>
      wantsThreads && getStreamName(s) != null && !hiddenRootIds.has(s.rootStreamId ?? s.id)

    // Own asides are palette-reachable — the one list surface they appear on
    // besides their anchor row (the sidebar and pickers hide them).
    let filteredStreams = allStreams.filter(
      (s) =>
        s.type === StreamTypes.SCRATCHPAD ||
        s.type === StreamTypes.CHANNEL ||
        s.type === StreamTypes.DM ||
        s.type === StreamTypes.SYSTEM ||
        (s.type === StreamTypes.ASIDE && s.createdBy === currentUserId) ||
        (s.type === StreamTypes.THREAD && isSearchableThread(s))
    )

    if (typeFilters.length > 0) {
      filteredStreams = filteredStreams.filter((s) => typeFilters.includes(s.type))
    }

    // A thread title alone is ambiguous out of context; name where it lives.
    const streamsById = new Map(allStreams.map((s) => [s.id, s]))
    const parentLabelFor = (stream: StreamLike): string | null => {
      const parent = stream.parentStreamId ? streamsById.get(stream.parentStreamId) : undefined
      return parent ? streamLabel(parent) : null
    }

    // Score first, then pre-compute urgency and counts for the survivors only
    // (used by both sort and item builder): with threads in the candidate set the
    // list is an order of magnitude longer, and most of it never renders.
    const enriched = filteredStreams
      .map((stream) => ({ stream, score: scoreStreamMatch(stream, lowerQuery) }))
      .filter(({ score }) => score !== Infinity)
      .map(({ stream, score }) => {
        const unreadCount = getUnreadCount(stream.id)
        const mentionCount = getMentionCount(stream.id)
        const activityCount = getActivityCount(stream.id)
        const isMuted = mutedStreamIds.has(stream.id)
        const urgency = calculateUrgency(stream, unreadCount, mentionCount, isMuted, activityCount)
        return { stream, score, unreadCount, mentionCount, urgency }
      })

    // Quick-switcher always uses the recency-style browsing order; the share
    // pickers expose a toggle but reuse the same comparator.
    const sortedStreams = enriched.sort((a, b) => compareStreamEntries(a, b, { isSearching, mode: "recency" }))
    const toStreamItem = ({
      stream,
      unreadCount,
      mentionCount,
      urgency,
    }: (typeof enriched)[number]): QuickSwitcherItem => {
      // An aside is never a page: selecting one lands on its host and opens the
      // surface there, the way its anchor row does.
      const asideHost = stream.type === StreamTypes.ASIDE ? stream.parentStreamId : null
      const href = `/w/${workspaceId}/s/${asideHost ?? stream.id}`
      const isArchived = stream.archivedAt != null
      const typeLabel = getStreamTypeLabel(stream.type)
      // Threads carry no member rows (INV-62) — access is inherited from the
      // root — so "Not joined" would be true of every one of them.
      const isThread = stream.type === StreamTypes.THREAD
      const notJoined = !isThread && !memberStreamIds.has(stream.id) && stream.visibility === "public"
      const parentLabel = isThread ? parentLabelFor(stream) : null
      let description = parentLabel ? `${typeLabel} · in ${parentLabel}` : typeLabel
      if (isArchived) description = `${description} · Archived`
      else if (notJoined) description = `${typeLabel} · Not joined`

      let avatarUrl: string | undefined
      if (stream.type === StreamTypes.DM) {
        const peerUserId = dmPeerByStreamId.get(stream.id)
        const peerUser = peerUserId ? usersById.get(peerUserId) : undefined
        avatarUrl = getAvatarUrl(workspaceId, peerUser?.avatarUrl, 64)
      }

      return {
        id: stream.id,
        label: streamLabel(stream),
        description,
        icon: STREAM_ICONS[stream.type],
        avatarUrl,
        href,
        onSelect: () => {
          closeDialog()
          if (asideHost) {
            openAside({
              hostKey: href,
              hostStreamId: asideHost,
              asideId: stream.id,
              originScope: draftStreamScope(asideHost),
            })
          }
          navigate(href)
        },
        urgency,
        unreadCount,
        mentionCount,
      }
    }

    const canShowVirtualDms =
      Boolean(currentUserId) &&
      Boolean(users) &&
      showActive &&
      (typeFilters.length === 0 || typeFilters.includes(StreamTypes.DM))

    if (!canShowVirtualDms) {
      return sortedStreams.map(toStreamItem)
    }

    const existingDmPeerIds = new Set((dmPeers ?? []).map((peer) => peer.userId))
    const scoredVirtualDms = users!
      .filter((workspaceUser) => workspaceUser.id !== currentUserId)
      .filter((workspaceUser) => !existingDmPeerIds.has(workspaceUser.id))
      .map((workspaceUser) => ({
        workspaceUser,
        score: searchText ? scoreMatch(lowerQuery, [workspaceUser.name]) : 0,
      }))
      .filter(({ score }) => score !== Infinity)

    // Streams always render above users, so the two independently scored lists
    // are compared before they are concatenated: without this a stream matched
    // only by the typo band outranks a user whose name matches exactly, and
    // Enter (which fires the first row) opens the wrong thing. Same rule as
    // rankGroups in use-command-items.
    const hasRealMatch =
      enriched.some(({ score }) => !isToleranceMatch(score)) ||
      scoredVirtualDms.some(({ score }) => !isToleranceMatch(score))

    const keep = (score: number) => !hasRealMatch || !isToleranceMatch(score)

    const virtualDmItems = scoredVirtualDms
      .filter(({ score }) => keep(score))
      .sort((a, b) => a.workspaceUser.name.localeCompare(b.workspaceUser.name))
      .map(
        ({ workspaceUser }): QuickSwitcherItem => ({
          id: createDmDraftId(workspaceUser.id),
          label: workspaceUser.name,
          description: "Direct Message · Start conversation",
          icon: STREAM_ICONS[StreamTypes.DM],
          avatarUrl: getAvatarUrl(workspaceId, workspaceUser.avatarUrl, 64),
          group: "Users",
          href: `/w/${workspaceId}/s/${createDmDraftId(workspaceUser.id)}`,
          onSelect: () => {
            closeDialog()
            navigate(`/w/${workspaceId}/s/${createDmDraftId(workspaceUser.id)}`)
          },
        })
      )

    return [...sortedStreams.filter(({ score }) => keep(score)).map(toStreamItem), ...virtualDmItems]
  }, [
    activeStreams,
    archivedStreams,
    currentUserId,
    dmPeers,
    users,
    searchText,
    showActive,
    showArchived,
    typeFilters,
    memberStreamIds,
    workspaceId,
    navigate,
    closeDialog,
    getUnreadCount,
    getMentionCount,
    getActivityCount,
    mutedStreamIds,
  ])

  const header = (
    <>
      {(parsedFilters.length > 0 || addingFilter) && (
        <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
          {parsedFilters.map((filter, index) => (
            <Badge key={index} variant="secondary" className="gap-1 pr-1">
              {getFilterIcon(filter.type)}
              <span className="text-xs">{getFilterLabel(filter)}</span>
              <Button
                variant="ghost"
                size="icon"
                className="h-4 w-4 rounded-full hover:bg-destructive/20"
                onClick={() => handleRemoveFilter(index)}
              >
                <X className="h-3 w-3" />
              </Button>
            </Badge>
          ))}
          {addingFilter && (
            <FilterSelect
              type={addingFilter}
              users={[]} // Not needed for stream status/type
              streams={[]} // Not needed
              streamTypes={STREAM_TYPE_OPTIONS}
              statusOptions={ARCHIVE_STATUS_OPTIONS}
              onSelect={handleFilterSelect}
              onCancel={() => setAddingFilter(null)}
            />
          )}
        </div>
      )}

      <div className="flex items-center gap-2 border-b px-3 py-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="h-7 gap-1 text-xs">
              <Plus className="h-3 w-3" />
              Add filter
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {FILTER_TYPES.map(({ type, label, icon }) => (
              <DropdownMenuItem key={type} onClick={() => handleAddFilter(type)}>
                {icon}
                <span className="ml-2">{label}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </>
  )

  return {
    items,
    isLoading: showArchived && isLoadingArchived,
    emptyMessage: "No streams found.",
    header,
    isFilterSelectActive: addingFilter !== null,
    closeFilterSelect,
  }
}
