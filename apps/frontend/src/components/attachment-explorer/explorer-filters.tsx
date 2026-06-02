import { useEffect, useMemo, useState, type ComponentType, type ReactNode } from "react"
import { X, Filter as FilterIcon, Hash, User as UserIcon, Calendar, FileType, FileText } from "lucide-react"
import { StreamTypes, type AttachmentCategory } from "@threa/types"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useWorkspaceStreams, useWorkspaceUnreadState, useWorkspaceUsers } from "@/stores/workspace-store"
import { useActivityCounts, useUnreadCounts } from "@/hooks"
import { calculateUrgency } from "@/components/layout/sidebar/utils"
import { compareStreamEntries, scoreStreamMatch } from "@/lib/stream-sort"
import { streamLabel, STREAM_ICONS } from "@/lib/streams"
import { CATEGORY_OPTIONS } from "./category"
import type { ExplorerFilters } from "./use-explorer-url-state"

interface ExplorerFiltersProps {
  workspaceId: string
  filters: ExplorerFilters
  /** When the explorer was opened from a thread, surface the parent so the
   *  caller can offer a one-click "Include #parent" expansion. */
  parentStreamId: string | null
  onUpdate: (next: Partial<ExplorerFilters>) => void
}

interface FilterChipProps {
  icon: ComponentType<{ className?: string }>
  label: ReactNode
  removeLabel: string
  onRemove: () => void
  /** When set, applies `${labelMaxWidth} truncate` so long labels clip. */
  labelMaxWidth?: string
}

function FilterChip({ icon: Icon, label, removeLabel, onRemove, labelMaxWidth }: FilterChipProps) {
  return (
    <Badge variant="secondary" className="gap-1 pr-1">
      <Icon className="h-3 w-3" />
      <span className={labelMaxWidth ? `${labelMaxWidth} truncate` : undefined}>{label}</span>
      <button
        type="button"
        className="rounded-full p-0.5 transition-colors hover:bg-foreground/10 hover:text-foreground"
        onClick={onRemove}
        aria-label={removeLabel}
      >
        <X className="h-3 w-3" />
      </button>
    </Badge>
  )
}

export function ExplorerFilters({ workspaceId, filters, parentStreamId, onUpdate }: ExplorerFiltersProps) {
  const streams = useWorkspaceStreams(workspaceId)
  const users = useWorkspaceUsers(workspaceId)
  const { getUnreadCount } = useUnreadCounts(workspaceId)
  const { getMentionCount, getActivityCount } = useActivityCounts(workspaceId)
  const unreadState = useWorkspaceUnreadState(workspaceId)
  const mutedStreamIds = useMemo(() => new Set(unreadState?.mutedStreamIds ?? []), [unreadState?.mutedStreamIds])

  const [nameDraft, setNameDraft] = useState(filters.nameSubstring ?? "")
  useEffect(() => {
    setNameDraft(filters.nameSubstring ?? "")
  }, [filters.nameSubstring])

  const [streamSearch, setStreamSearch] = useState("")

  const streamById = useMemo(() => new Map(streams.map((s) => [s.id, s])), [streams])

  const selectedStreams = useMemo(() => {
    return filters.streamIds.map((id) => ({ id, stream: streamById.get(id) ?? null }))
  }, [filters.streamIds, streamById])

  const parentStream = useMemo(() => {
    if (!parentStreamId) return null
    return streamById.get(parentStreamId) ?? null
  }, [parentStreamId, streamById])

  const uploaderUser = useMemo(() => {
    if (!filters.uploadedBy) return null
    return users.find((u) => u.id === filters.uploadedBy) ?? null
  }, [filters.uploadedBy, users])

  // Picker entries: scored + sorted with the same comparator the quick
  // switcher uses, so naming and ordering stay aligned across surfaces.
  // Threads stay out (the quick switcher hides them), as do archived
  // streams unless they're already selected in the filter.
  const pickerEntries = useMemo(() => {
    const lowerQuery = streamSearch.trim().toLowerCase()
    const isSearching = lowerQuery.length > 0
    const selectedSet = new Set(filters.streamIds)
    return streams
      .filter(
        (s) =>
          s.type === StreamTypes.SCRATCHPAD ||
          s.type === StreamTypes.CHANNEL ||
          s.type === StreamTypes.DM ||
          s.type === StreamTypes.SYSTEM
      )
      .filter((s) => !s.archivedAt || selectedSet.has(s.id))
      .map((stream) => {
        const score = scoreStreamMatch(stream, lowerQuery)
        const unreadCount = getUnreadCount(stream.id)
        const mentionCount = getMentionCount(stream.id)
        const activityCount = getActivityCount(stream.id)
        const isMuted = mutedStreamIds.has(stream.id)
        const urgency = calculateUrgency(stream, unreadCount, mentionCount, isMuted, activityCount)
        return { stream, score, urgency }
      })
      .filter(({ score }) => score !== Infinity)
      .sort((a, b) => compareStreamEntries(a, b, { isSearching, mode: "recency" }))
  }, [streams, streamSearch, filters.streamIds, getUnreadCount, getMentionCount, getActivityCount, mutedStreamIds])

  const labelForStream = (stream: { type: string; displayName?: string | null; slug?: string | null }) =>
    streamLabel(stream)

  const toggleCategory = (cat: AttachmentCategory) => {
    const set = new Set(filters.categories)
    if (set.has(cat)) set.delete(cat)
    else set.add(cat)
    onUpdate({ categories: Array.from(set) })
  }

  const toggleStream = (id: string) => {
    const set = new Set(filters.streamIds)
    if (set.has(id)) set.delete(id)
    else set.add(id)
    onUpdate({ streamIds: Array.from(set) })
  }

  const includeParent = () => {
    if (!parentStream) return
    if (filters.streamIds.includes(parentStream.id)) return
    onUpdate({ streamIds: [...filters.streamIds, parentStream.id] })
  }

  return (
    <div className="flex flex-wrap items-center gap-2 px-3 pb-3 pt-1">
      {selectedStreams.map(({ id, stream }) => (
        <FilterChip
          key={id}
          icon={stream ? STREAM_ICONS[stream.type] : Hash}
          label={stream ? labelForStream(stream) : "stream"}
          labelMaxWidth="max-w-[140px]"
          removeLabel="Remove stream filter"
          onRemove={() => onUpdate({ streamIds: filters.streamIds.filter((s) => s !== id) })}
        />
      ))}

      {filters.categories.map((cat) => (
        <FilterChip
          key={cat}
          icon={FileType}
          label={cat}
          removeLabel={`Remove ${cat} filter`}
          onRemove={() => toggleCategory(cat)}
        />
      ))}

      {uploaderUser ? (
        <FilterChip
          icon={UserIcon}
          label={uploaderUser.name || uploaderUser.slug}
          labelMaxWidth="max-w-[120px]"
          removeLabel="Remove uploader filter"
          onRemove={() => onUpdate({ uploadedBy: null })}
        />
      ) : null}

      {filters.nameSubstring ? (
        <FilterChip
          icon={FileText}
          label={`name: ${filters.nameSubstring}`}
          labelMaxWidth="max-w-[140px]"
          removeLabel="Remove name filter"
          onRemove={() => {
            setNameDraft("")
            onUpdate({ nameSubstring: null })
          }}
        />
      ) : null}

      {filters.before ? (
        <FilterChip
          icon={Calendar}
          label={`before ${filters.before.slice(0, 10)}`}
          removeLabel="Remove before filter"
          onRemove={() => onUpdate({ before: null })}
        />
      ) : null}

      {filters.after ? (
        <FilterChip
          icon={Calendar}
          label={`after ${filters.after.slice(0, 10)}`}
          removeLabel="Remove after filter"
          onRemove={() => onUpdate({ after: null })}
        />
      ) : null}

      <Popover>
        <PopoverTrigger asChild>
          <Button size="sm" variant="outline" className="h-7 gap-1 text-xs">
            <Hash className="h-3 w-3" />
            Stream
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-72 p-0" align="start">
          <div className="border-b p-2">
            <Input
              autoFocus
              value={streamSearch}
              onChange={(e) => setStreamSearch(e.target.value)}
              placeholder="Find stream"
              className="h-8"
              aria-label="Find stream"
            />
          </div>
          <div className="max-h-64 overflow-y-auto py-1">
            {pickerEntries.length === 0 ? (
              <div className="px-3 py-2 text-xs text-muted-foreground">No streams match</div>
            ) : (
              pickerEntries.map(({ stream }) => {
                const checked = filters.streamIds.includes(stream.id)
                const Icon = STREAM_ICONS[stream.type]
                return (
                  <button
                    key={stream.id}
                    type="button"
                    onClick={() => toggleStream(stream.id)}
                    className="mx-1 flex w-[calc(100%-0.5rem)] items-center gap-2 rounded-item px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted"
                  >
                    <Checkbox checked={checked} tabIndex={-1} aria-hidden className="pointer-events-none" />
                    <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="flex-1 truncate">{labelForStream(stream)}</span>
                  </button>
                )
              })
            )}
          </div>
          {filters.streamIds.length > 0 ? (
            <div className="flex justify-end border-t p-2">
              <Button size="sm" variant="ghost" onClick={() => onUpdate({ streamIds: [] })}>
                Clear streams
              </Button>
            </div>
          ) : null}
        </PopoverContent>
      </Popover>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="outline" className="h-7 gap-1 text-xs">
            <FilterIcon className="h-3 w-3" />
            Add filter
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          <DropdownMenuLabel>File type</DropdownMenuLabel>
          {CATEGORY_OPTIONS.filter((o) => o.value !== "other").map((opt) => (
            <DropdownMenuCheckboxItem
              key={opt.value}
              checked={filters.categories.includes(opt.value)}
              onCheckedChange={() => toggleCategory(opt.value)}
            >
              {opt.label}
            </DropdownMenuCheckboxItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Uploader</DropdownMenuLabel>
          {users.slice(0, 8).map((u) => (
            <DropdownMenuItem
              key={u.id}
              onSelect={() => onUpdate({ uploadedBy: u.id })}
              disabled={filters.uploadedBy === u.id}
            >
              {u.name || u.slug}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <Popover>
        <PopoverTrigger asChild>
          <Button size="sm" variant="outline" className="h-7 gap-1 text-xs">
            <FileText className="h-3 w-3" />
            Filename
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-64 space-y-2 p-3" align="start">
          <div className="text-xs font-medium">Match filename substring</div>
          <Input
            value={nameDraft}
            placeholder="invoice-2026"
            onChange={(e) => setNameDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                onUpdate({ nameSubstring: nameDraft.trim() || null })
              }
            }}
          />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setNameDraft("")}>
              Clear
            </Button>
            <Button size="sm" onClick={() => onUpdate({ nameSubstring: nameDraft.trim() || null })}>
              Apply
            </Button>
          </div>
        </PopoverContent>
      </Popover>

      <Popover>
        <PopoverTrigger asChild>
          <Button size="sm" variant="outline" className="h-7 gap-1 text-xs">
            <Calendar className="h-3 w-3" />
            Date
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-64 space-y-2 p-3" align="start">
          <label className="block text-xs">
            <span className="mb-1 block font-medium">After</span>
            <Input
              type="date"
              value={filters.after?.slice(0, 10) ?? ""}
              onChange={(e) => {
                const value = e.target.value
                onUpdate({ after: value ? new Date(value).toISOString() : null })
              }}
            />
          </label>
          <label className="block text-xs">
            <span className="mb-1 block font-medium">Before</span>
            <Input
              type="date"
              value={filters.before?.slice(0, 10) ?? ""}
              onChange={(e) => {
                const value = e.target.value
                onUpdate({ before: value ? new Date(value).toISOString() : null })
              }}
            />
          </label>
        </PopoverContent>
      </Popover>

      {parentStream && !filters.streamIds.includes(parentStream.id) ? (
        <Button
          size="sm"
          variant="ghost"
          className="h-7 text-xs"
          onClick={includeParent}
          title={`Include the parent channel ${labelForStream(parentStream)}`}
        >
          + Include {labelForStream(parentStream)}
        </Button>
      ) : null}
    </div>
  )
}
