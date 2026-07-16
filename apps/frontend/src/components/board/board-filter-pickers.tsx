import { useEffect, useMemo, useState, type ComponentType, type ReactNode } from "react"
import { Ban, Bell, BellOff, ChevronDown, Hash, Layers, Tag, X } from "lucide-react"
import {
  BOARD_SCOPE_STREAM_TYPES,
  MAX_BOARD_SCOPE_STREAMS,
  MAX_BOARD_SCOPE_LABELS,
  type BoardScopeStreamType,
} from "@threa/types"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Drawer, DrawerContent, DrawerTitle, DrawerTrigger } from "@/components/ui/drawer"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useInputMode } from "@/hooks/use-input-mode"
import { useWorkspaceStreams } from "@/stores/workspace-store"
import type { CachedLabel } from "@/hooks/use-labels"
import { scoreMatch } from "@/lib/match-score"
import { STREAM_ICONS } from "@/lib/streams"
import { toggleExclude, toggleInclude } from "@/components/board/board-filter-params"
import { BOARD_STREAM_TYPE_LABELS as TYPE_LABELS } from "@/lib/board/stream-type-labels"
import { cn } from "@/lib/utils"

/** Stream types offered in the pickers: the board's root-stream grains (shared
 *  with the backend validator). */
const SCOPE_STREAM_TYPES = new Set<string>(BOARD_SCOPE_STREAM_TYPES)

/** A dimension's include/exclude rewrite: both lists in one URL write. */
export type FilterChange<T> = (include: T[], exclude: T[]) => void

/** Chip/row glyph: lucide icons and the `STREAM_ICONS` components both fit. */
export type FilterIcon = ComponentType<{ className?: string }>

/**
 * One filter selection rendered as a removable chip. An `excluded` chip reads as
 * a veto: "Not:" prefix + destructive tint, so a narrowed board and a vetoed
 * stream can't be confused at a glance.
 */
export function FilterChip({
  icon: Icon,
  label,
  excluded,
  swatch,
  onRemove,
  removeLabel,
}: {
  icon: FilterIcon
  label: string
  excluded?: boolean
  /** Label color dot (labels only). */
  swatch?: string
  onRemove: () => void
  removeLabel: string
}) {
  return (
    <Badge
      variant="secondary"
      className={cn("shrink-0 gap-1 pr-1", excluded && "bg-destructive/10 text-destructive dark:bg-destructive/20")}
    >
      {excluded && <span className="font-normal">Not:</span>}
      {swatch ? (
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: swatch }} aria-hidden />
      ) : (
        <Icon className="h-3 w-3" />
      )}
      <span className="max-w-[140px] truncate">{label}</span>
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

/**
 * Shared container for the board's filter pickers: popover for mouse input,
 * bottom drawer when a finger is active (the `SearchFilterMenu` split). One shell
 * so the pickers can't drift as sizing/a11y evolves.
 */
export function FilterMenuShell({
  title,
  open,
  onOpenChange,
  trigger,
  children,
}: {
  /** Screen-reader drawer title (visually hidden). */
  title: string
  open: boolean
  onOpenChange: (open: boolean) => void
  trigger: ReactNode
  children: ReactNode
}) {
  const isTouch = useInputMode() === "touch"

  if (isTouch) {
    return (
      <Drawer open={open} onOpenChange={onOpenChange}>
        <DrawerTrigger asChild>{trigger}</DrawerTrigger>
        <DrawerContent className="pb-[env(safe-area-inset-bottom)]">
          <DrawerTitle className="sr-only">{title}</DrawerTitle>
          {children}
        </DrawerContent>
      </Drawer>
    )
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange} modal={false}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="start">
        {children}
      </PopoverContent>
    </Popover>
  )
}

/**
 * The exclude half of a tri-state picker row: a ban toggle that vetoes the row's
 * id. Same footprint pressed or not (INV-21); the destructive tint marks the
 * active veto.
 */
function ExcludeToggle({ excluded, onToggle, subject }: { excluded: boolean; onToggle: () => void; subject: string }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={excluded}
      aria-label={excluded ? `Stop excluding ${subject} from the board` : `Exclude ${subject} from the board`}
      className={cn(
        "shrink-0 rounded p-1 transition-colors",
        excluded ? "text-destructive" : "text-muted-foreground/60 hover:text-foreground"
      )}
    >
      <Ban className="h-3.5 w-3.5" />
    </button>
  )
}

/**
 * Stream picker: a searchable tri-state multi-select over the workspace's root
 * streams (channels, DMs, scratchpads, system). The row toggles include
 * (`?in=`), the ban toggle vetoes (`?not-in=`); both rewrite through the caller.
 * Each list is capped at the shared server limit so the picker can't build a
 * URL the backend rejects.
 */
export function BoardScopePicker({
  workspaceId,
  scopeStreamIds,
  excludeStreamIds,
  onStreamFilterChange,
  labelFor,
  mutedStreamIds,
  onToggleMute,
}: {
  workspaceId: string
  scopeStreamIds: string[]
  excludeStreamIds: string[]
  onStreamFilterChange: FilterChange<string>
  labelFor: (streamId: string) => string
  mutedStreamIds?: ReadonlySet<string>
  onToggleMute?: (streamId: string, mute: boolean) => void
}) {
  const isTouch = useInputMode() === "touch"
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState("")
  const streams = useWorkspaceStreams(workspaceId)
  const included = useMemo(() => new Set(scopeStreamIds), [scopeStreamIds])
  const excluded = useMemo(() => new Set(excludeStreamIds), [excludeStreamIds])
  const atIncludeCap = scopeStreamIds.length >= MAX_BOARD_SCOPE_STREAMS
  const atExcludeCap = excludeStreamIds.length >= MAX_BOARD_SCOPE_STREAMS

  // Reopening always starts unfiltered.
  useEffect(() => {
    if (!open) setSearch("")
  }, [open])

  const entries = useMemo(() => {
    const lower = search.trim().toLowerCase()
    const isSelected = (id: string) => included.has(id) || excluded.has(id)
    return streams
      .filter((s) => SCOPE_STREAM_TYPES.has(s.type))
      .filter((s) => !s.archivedAt || isSelected(s.id))
      .map((stream) => ({ stream, label: labelFor(stream.id) }))
      .filter(({ label }) => !lower || scoreMatch(lower, [label]) !== Infinity)
      .sort((a, b) => {
        const bySelected = Number(isSelected(b.stream.id)) - Number(isSelected(a.stream.id))
        return bySelected !== 0 ? bySelected : a.label.localeCompare(b.label)
      })
  }, [streams, search, included, excluded, labelFor])

  const toggle = (id: string) => {
    if (!included.has(id) && atIncludeCap) return
    const next = toggleInclude(id, scopeStreamIds, excludeStreamIds)
    onStreamFilterChange(next.include, next.exclude)
  }
  const toggleVeto = (id: string) => {
    if (!excluded.has(id) && atExcludeCap) return
    const next = toggleExclude(id, scopeStreamIds, excludeStreamIds)
    onStreamFilterChange(next.include, next.exclude)
  }

  const content = (
    <>
      <div className="border-b p-2">
        <Input
          autoFocus={!isTouch}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Find a stream"
          className="h-8"
          aria-label="Find a stream to filter the board by"
        />
      </div>
      <div className="max-h-64 overflow-y-auto overscroll-contain py-1">
        {entries.length === 0 ? (
          <div className="px-3 py-2 text-xs text-muted-foreground">No streams match</div>
        ) : (
          entries.map(({ stream, label }) => {
            const checked = included.has(stream.id)
            const vetoed = excluded.has(stream.id)
            const isMuted = mutedStreamIds?.has(stream.id) ?? false
            const Icon = STREAM_ICONS[stream.type]
            return (
              <div
                key={stream.id}
                className="mx-1 flex w-[calc(100%-0.5rem)] items-center rounded-item pr-1 transition-colors hover:bg-muted"
              >
                <button
                  type="button"
                  onClick={() => toggle(stream.id)}
                  aria-pressed={checked}
                  disabled={!checked && atIncludeCap}
                  className="flex flex-1 items-center gap-2 px-2 py-1.5 text-left text-sm disabled:opacity-50"
                >
                  <Checkbox checked={checked} tabIndex={-1} aria-hidden className="pointer-events-none" />
                  <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className={cn("flex-1 truncate", vetoed && "text-muted-foreground line-through")}>{label}</span>
                </button>
                <ExcludeToggle excluded={vetoed} onToggle={() => toggleVeto(stream.id)} subject={label} />
                {onToggleMute && (
                  <button
                    type="button"
                    onClick={() => onToggleMute(stream.id, !isMuted)}
                    aria-pressed={isMuted}
                    aria-label={isMuted ? `Unmute ${label} on the board` : `Mute ${label} from the board`}
                    className={cn(
                      "shrink-0 rounded p-1 transition-colors",
                      isMuted ? "text-foreground" : "text-muted-foreground/60 hover:text-foreground"
                    )}
                  >
                    {isMuted ? <BellOff className="h-3.5 w-3.5" /> : <Bell className="h-3.5 w-3.5" />}
                  </button>
                )}
              </div>
            )
          })
        )}
        {(atIncludeCap || atExcludeCap) && (
          <p className="px-3 py-1.5 text-[11px] text-muted-foreground">
            Each list is limited to {MAX_BOARD_SCOPE_STREAMS} streams
          </p>
        )}
      </div>
      {(scopeStreamIds.length > 0 || excludeStreamIds.length > 0) && (
        <div className="flex justify-end border-t p-2">
          <Button size="sm" variant="ghost" onClick={() => onStreamFilterChange([], [])}>
            Clear streams
          </Button>
        </div>
      )}
    </>
  )

  const trigger = (
    <Button
      variant={scopeStreamIds.length > 0 || excludeStreamIds.length > 0 ? "secondary" : "outline"}
      size="sm"
      className="h-7 shrink-0 gap-1.5 rounded-full px-2.5 text-xs font-normal"
      aria-label="Filter the board by streams"
    >
      <Hash className="h-3.5 w-3.5" />
      Streams
      <ChevronDown className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
    </Button>
  )

  return (
    <FilterMenuShell title="Filter the board by streams" open={open} onOpenChange={setOpen} trigger={trigger}>
      {content}
    </FilterMenuShell>
  )
}

/**
 * Root-stream TYPE picker: a fixed tri-state multi-select over the board's root
 * grains. Matches by the conversation's effective root — a thread under a
 * channel counts as Channels — mirroring the stream picker's root rule.
 */
export function BoardTypePicker({
  scopeStreamTypes,
  excludeStreamTypes,
  onTypeFilterChange,
}: {
  scopeStreamTypes: BoardScopeStreamType[]
  excludeStreamTypes: BoardScopeStreamType[]
  onTypeFilterChange: FilterChange<BoardScopeStreamType>
}) {
  const [open, setOpen] = useState(false)
  const included = useMemo(() => new Set(scopeStreamTypes), [scopeStreamTypes])
  const excluded = useMemo(() => new Set(excludeStreamTypes), [excludeStreamTypes])

  const toggle = (type: BoardScopeStreamType) => {
    const next = toggleInclude(type, scopeStreamTypes, excludeStreamTypes)
    onTypeFilterChange(next.include, next.exclude)
  }
  const toggleVeto = (type: BoardScopeStreamType) => {
    const next = toggleExclude(type, scopeStreamTypes, excludeStreamTypes)
    onTypeFilterChange(next.include, next.exclude)
  }

  const content = (
    <div className="py-1">
      {BOARD_SCOPE_STREAM_TYPES.map((type) => {
        const checked = included.has(type)
        const vetoed = excluded.has(type)
        const Icon = STREAM_ICONS[type] || Layers
        return (
          <div
            key={type}
            className="mx-1 flex w-[calc(100%-0.5rem)] items-center rounded-item pr-1 transition-colors hover:bg-muted"
          >
            <button
              type="button"
              onClick={() => toggle(type)}
              aria-pressed={checked}
              className="flex flex-1 items-center gap-2 px-2 py-1.5 text-left text-sm"
            >
              <Checkbox checked={checked} tabIndex={-1} aria-hidden className="pointer-events-none" />
              <Icon className="h-3.5 w-3.5 text-muted-foreground" />
              <span className={cn("flex-1 truncate", vetoed && "text-muted-foreground line-through")}>
                {TYPE_LABELS[type]}
              </span>
            </button>
            <ExcludeToggle excluded={vetoed} onToggle={() => toggleVeto(type)} subject={TYPE_LABELS[type]} />
          </div>
        )
      })}
    </div>
  )

  const trigger = (
    <Button
      variant={scopeStreamTypes.length > 0 || excludeStreamTypes.length > 0 ? "secondary" : "outline"}
      size="sm"
      className="h-7 shrink-0 gap-1.5 rounded-full px-2.5 text-xs font-normal"
      aria-label="Filter the board by stream types"
    >
      <Layers className="h-3.5 w-3.5" />
      Type
      <ChevronDown className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
    </Button>
  )

  return (
    <FilterMenuShell title="Filter the board by stream types" open={open} onOpenChange={setOpen} trigger={trigger}>
      {content}
    </FilterMenuShell>
  )
}

/**
 * Label picker: a searchable tri-state multi-select over the viewer's own
 * labels (labels are owner-scoped). Include (`?label=`) scopes the board to
 * conversations whose stream carries a label; the ban toggle (`?not-label=`)
 * vetoes them — e.g. exclude everything labeled "coding" in one move. A label
 * matches a conversation by its anchor or effective root stream, the same rule
 * as the stream picker.
 */
export function BoardLabelPicker({
  myLabels,
  scopeLabelIds,
  excludeLabelIds,
  onLabelFilterChange,
}: {
  myLabels: CachedLabel[]
  scopeLabelIds: string[]
  excludeLabelIds: string[]
  onLabelFilterChange: FilterChange<string>
}) {
  const isTouch = useInputMode() === "touch"
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState("")
  const included = useMemo(() => new Set(scopeLabelIds), [scopeLabelIds])
  const excluded = useMemo(() => new Set(excludeLabelIds), [excludeLabelIds])
  const atIncludeCap = scopeLabelIds.length >= MAX_BOARD_SCOPE_LABELS
  const atExcludeCap = excludeLabelIds.length >= MAX_BOARD_SCOPE_LABELS

  useEffect(() => {
    if (!open) setSearch("")
  }, [open])

  const entries = useMemo(() => {
    const lower = search.trim().toLowerCase()
    const isSelected = (id: string) => included.has(id) || excluded.has(id)
    return myLabels
      .filter((label) => !lower || scoreMatch(lower, [label.name]) !== Infinity)
      .sort((a, b) => {
        const bySelected = Number(isSelected(b.id)) - Number(isSelected(a.id))
        return bySelected !== 0 ? bySelected : a.name.localeCompare(b.name)
      })
  }, [myLabels, search, included, excluded])

  const toggle = (id: string) => {
    if (!included.has(id) && atIncludeCap) return
    const next = toggleInclude(id, scopeLabelIds, excludeLabelIds)
    onLabelFilterChange(next.include, next.exclude)
  }
  const toggleVeto = (id: string) => {
    if (!excluded.has(id) && atExcludeCap) return
    const next = toggleExclude(id, scopeLabelIds, excludeLabelIds)
    onLabelFilterChange(next.include, next.exclude)
  }

  const content = (
    <>
      <div className="border-b p-2">
        <Input
          autoFocus={!isTouch}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Find a label"
          className="h-8"
          aria-label="Find a label to filter the board by"
        />
      </div>
      <div className="max-h-64 overflow-y-auto overscroll-contain py-1">
        {entries.length === 0 ? (
          <div className="px-3 py-2 text-xs text-muted-foreground">No labels match</div>
        ) : (
          entries.map((label) => {
            const checked = included.has(label.id)
            const vetoed = excluded.has(label.id)
            return (
              <div
                key={label.id}
                className="mx-1 flex w-[calc(100%-0.5rem)] items-center rounded-item pr-1 transition-colors hover:bg-muted"
              >
                <button
                  type="button"
                  onClick={() => toggle(label.id)}
                  aria-pressed={checked}
                  disabled={!checked && atIncludeCap}
                  className="flex flex-1 items-center gap-2 px-2 py-1.5 text-left text-sm disabled:opacity-50"
                >
                  <Checkbox checked={checked} tabIndex={-1} aria-hidden className="pointer-events-none" />
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: label.color }}
                    aria-hidden
                  />
                  <span className={cn("flex-1 truncate", vetoed && "text-muted-foreground line-through")}>
                    {label.emoji ? `${label.emoji} ${label.name}` : label.name}
                  </span>
                </button>
                <ExcludeToggle excluded={vetoed} onToggle={() => toggleVeto(label.id)} subject={label.name} />
              </div>
            )
          })
        )}
        {(atIncludeCap || atExcludeCap) && (
          <p className="px-3 py-1.5 text-[11px] text-muted-foreground">
            Each list is limited to {MAX_BOARD_SCOPE_LABELS} labels
          </p>
        )}
      </div>
      {(scopeLabelIds.length > 0 || excludeLabelIds.length > 0) && (
        <div className="flex justify-end border-t p-2">
          <Button size="sm" variant="ghost" onClick={() => onLabelFilterChange([], [])}>
            Clear labels
          </Button>
        </div>
      )}
    </>
  )

  const trigger = (
    <Button
      variant={scopeLabelIds.length > 0 || excludeLabelIds.length > 0 ? "secondary" : "outline"}
      size="sm"
      className="h-7 shrink-0 gap-1.5 rounded-full px-2.5 text-xs font-normal"
      aria-label="Filter the board by labels"
    >
      <Tag className="h-3.5 w-3.5" />
      Labels
      <ChevronDown className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
    </Button>
  )

  return (
    <FilterMenuShell title="Filter the board by labels" open={open} onOpenChange={setOpen} trigger={trigger}>
      {content}
    </FilterMenuShell>
  )
}
