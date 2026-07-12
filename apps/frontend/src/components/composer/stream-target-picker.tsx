import { useMemo, useState, useEffect, type ReactNode } from "react"
import { ChevronsUpDown, Clock, ArrowDownAZ, PenSquare, StickyNote } from "lucide-react"
import { StreamTypes, type StreamType } from "@threa/types"
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Drawer, DrawerContent, DrawerTitle, DrawerTrigger } from "@/components/ui/drawer"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Button } from "@/components/ui/button"
import { useInputMode } from "@/hooks/use-input-mode"
import { useStreamPickerGroups } from "@/hooks/use-stream-picker-groups"
import { useStoredStreamSortMode } from "@/lib/stream-sort"
import {
  useWorkspaceStreams,
  useWorkspaceUsers,
  useWorkspaceDmPeers,
  type CachedStream,
} from "@/stores/workspace-store"
import { resolveStreamName, streamLabel, STREAM_ICONS } from "@/lib/streams"
import { isPostableStream, NEW_SCRATCHPAD, NEW_QUICK_NOTE } from "@/lib/board-post-target"
import { cn } from "@/lib/utils"

/** A pinned "create a new scratchpad" action. */
interface NewOption {
  value: string
  label: string
  hint: string
  icon: ReactNode
}

const NEW_OPTIONS: NewOption[] = [
  { value: NEW_SCRATCHPAD, label: "New scratchpad", hint: "with Ariadne", icon: <PenSquare className="h-4 w-4" /> },
  { value: NEW_QUICK_NOTE, label: "New quick note", hint: "just you", icon: <StickyNote className="h-4 w-4" /> },
]

/** Type groups rendered in order; channels first, then DMs. */
const TYPE_GROUPS: { type: StreamType; heading: string }[] = [
  { type: StreamTypes.CHANNEL, heading: "Channels" },
  { type: StreamTypes.DM, heading: "Direct messages" },
]

export interface StreamTargetPickerProps {
  workspaceId: string
  /** Current target: a stream id, a `new:*` sentinel, or `""` when unset. */
  value: string
  onChange: (value: string) => void
  /** Show the two "New …" mint options pinned at top (board/global authoring). */
  includeNewOptions?: boolean
  /** Which streams are targetable. Defaults to postable channels + DMs. */
  filter?: (stream: CachedStream) => boolean
  /** Recently-used target values (MRU); shown as a Recents group while browsing. */
  recents?: string[]
  disabled?: boolean
  className?: string
}

/**
 * The overlay composer's target picker: a chip that opens a searchable,
 * type-grouped stream list with the two "New scratchpad" mint options pinned on
 * top and a Recents group. Popover on a pointer, Drawer on touch — the house
 * `useInputMode` split. Reuses {@link useStreamPickerGroups} for the
 * filter/enrich/group/sort pipeline it shares with the share modal.
 */
export function StreamTargetPicker({
  workspaceId,
  value,
  onChange,
  includeNewOptions = false,
  filter = isPostableStream,
  recents,
  disabled = false,
  className,
}: StreamTargetPickerProps) {
  const isTouch = useInputMode() === "touch"
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState("")
  const [sortMode, setSortMode] = useStoredStreamSortMode()

  const streams = useWorkspaceStreams(workspaceId)
  const users = useWorkspaceUsers(workspaceId)
  const dmPeers = useWorkspaceDmPeers(workspaceId)
  const groups = useStreamPickerGroups(workspaceId, { search, sortMode, filter })

  // Reset the filter each time the picker closes so the next open shows everything.
  useEffect(() => {
    if (!open) setSearch("")
  }, [open])

  const lower = search.toLowerCase()
  const isSearching = lower.length > 0

  const newOptions = useMemo(
    () => (includeNewOptions ? NEW_OPTIONS.filter((o) => !isSearching || o.label.toLowerCase().includes(lower)) : []),
    [includeNewOptions, isSearching, lower]
  )

  // Resolve recent values to their picker rows: a sentinel keeps its New option,
  // a stream id must still be a targetable group member (dropped otherwise).
  const streamById = useMemo(() => {
    const map = new Map<string, CachedStream>()
    for (const list of groups.values()) for (const { stream } of list) map.set(stream.id, stream)
    return map
  }, [groups])
  const recentRows = useMemo(() => {
    if (isSearching || !recents) return []
    const rows: { value: string; label: string; icon: ReactNode }[] = []
    const seen = new Set<string>()
    for (const v of recents) {
      if (seen.has(v)) continue
      seen.add(v)
      const newOpt = NEW_OPTIONS.find((o) => o.value === v)
      if (newOpt && includeNewOptions) {
        rows.push({ value: v, label: newOpt.label, icon: newOpt.icon })
        continue
      }
      const stream = streamById.get(v)
      if (stream) {
        const Icon = STREAM_ICONS[stream.type]
        rows.push({ value: v, label: streamLabel(stream), icon: <Icon className="h-4 w-4 text-muted-foreground" /> })
      }
    }
    return rows.slice(0, 5)
  }, [isSearching, recents, includeNewOptions, streamById])

  const selectedLabel = useMemo(() => {
    if (!value) return null
    const newOpt = NEW_OPTIONS.find((o) => o.value === value)
    if (newOpt) return newOpt.label
    return resolveStreamName(value, { streams, users, dmPeers }, "generic") ?? "Untitled stream"
  }, [value, streams, users, dmPeers])

  const selectedIcon = useMemo(() => {
    if (!value) return null
    const newOpt = NEW_OPTIONS.find((o) => o.value === value)
    if (newOpt) return newOpt.icon
    const stream = streamById.get(value)
    if (!stream) return null
    const Icon = STREAM_ICONS[stream.type]
    return <Icon className="h-4 w-4" />
  }, [value, streamById])

  const handleSelect = (next: string) => {
    onChange(next)
    setOpen(false)
  }

  const hasAnyRow =
    newOptions.length > 0 || recentRows.length > 0 || TYPE_GROUPS.some((g) => (groups.get(g.type)?.length ?? 0) > 0)

  const trigger = (
    <Button
      type="button"
      variant="ghost"
      role="combobox"
      aria-expanded={open}
      disabled={disabled}
      className={cn(
        "h-8 gap-1.5 rounded-full border bg-background px-3 text-sm font-medium",
        !value && "text-muted-foreground",
        className
      )}
    >
      {selectedIcon}
      <span className="max-w-[40vw] truncate sm:max-w-[220px]">{selectedLabel ?? "Post to…"}</span>
      <ChevronsUpDown className={cn("h-3.5 w-3.5 shrink-0 opacity-50 transition-transform", open && "opacity-80")} />
    </Button>
  )

  const list = (
    <Command shouldFilter={false}>
      <div className="flex items-center gap-1 border-b px-1">
        <CommandInput
          placeholder="Search or start a post…"
          value={search}
          onValueChange={setSearch}
          className="flex-1 border-0"
        />
        <ToggleGroup
          type="single"
          size="sm"
          value={sortMode}
          onValueChange={(v) => {
            if (v === "recency" || v === "alphabetical") setSortMode(v)
          }}
          aria-label="Sort streams"
          className="shrink-0"
        >
          <ToggleGroupItem value="recency" aria-label="Sort by recent activity" title="Recent activity">
            <Clock className="h-3.5 w-3.5" aria-hidden="true" />
          </ToggleGroupItem>
          <ToggleGroupItem value="alphabetical" aria-label="Sort A–Z" title="A–Z">
            <ArrowDownAZ className="h-3.5 w-3.5" aria-hidden="true" />
          </ToggleGroupItem>
        </ToggleGroup>
      </div>
      <CommandList className="max-h-[min(60vh,360px)] overscroll-contain">
        {!hasAnyRow && <CommandEmpty>No matching streams.</CommandEmpty>}
        {newOptions.length > 0 && (
          <CommandGroup heading="Start something new">
            {newOptions.map((o) => (
              <CommandItem key={o.value} value={o.value} onSelect={() => handleSelect(o.value)} className="gap-2">
                <span className="flex h-4 w-4 items-center justify-center text-muted-foreground">{o.icon}</span>
                <span>{o.label}</span>
                <span className="ml-auto text-xs text-muted-foreground/70">{o.hint}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {recentRows.length > 0 && (
          <CommandGroup heading="Recent">
            {recentRows.map((r) => (
              <CommandItem
                key={`recent:${r.value}`}
                value={r.value}
                onSelect={() => handleSelect(r.value)}
                className="gap-2"
              >
                <span className="flex h-4 w-4 items-center justify-center">{r.icon}</span>
                <span className="truncate">{r.label}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {TYPE_GROUPS.map((group) => {
          const list = groups.get(group.type)
          if (!list || list.length === 0) return null
          return (
            <CommandGroup key={group.type} heading={group.heading}>
              {list.map(({ stream }) => {
                const Icon = STREAM_ICONS[stream.type]
                return (
                  <CommandItem
                    key={stream.id}
                    value={stream.id}
                    onSelect={() => handleSelect(stream.id)}
                    className="gap-2"
                  >
                    <Icon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                    <span className="truncate">{streamLabel(stream)}</span>
                  </CommandItem>
                )
              })}
            </CommandGroup>
          )
        })}
      </CommandList>
    </Command>
  )

  if (isTouch) {
    return (
      <Drawer open={open} onOpenChange={setOpen}>
        <DrawerTrigger asChild>{trigger}</DrawerTrigger>
        <DrawerContent className="pb-[env(safe-area-inset-bottom)]">
          <DrawerTitle className="sr-only">Choose where to post</DrawerTitle>
          {list}
        </DrawerContent>
      </Drawer>
    )
  }

  return (
    <Popover open={open} onOpenChange={setOpen} modal={false}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[320px] max-w-[calc(100vw-1rem)] p-0"
        onWheel={(e) => e.stopPropagation()}
      >
        {list}
      </PopoverContent>
    </Popover>
  )
}
