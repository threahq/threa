import { useEffect, useMemo, useState, type ComponentType, type ReactNode } from "react"
import { Link, useLocation } from "react-router-dom"
import { Archive, Ban, Bell, BellOff, Check, ChevronDown, Hash, Layers, Tag, X } from "lucide-react"
import {
  BOARD_LENSES,
  BOARD_SCOPE_STREAM_TYPES,
  MAX_BOARD_SCOPE_STREAMS,
  MAX_BOARD_SCOPE_LABELS,
  type BoardLens,
  type BoardScopeStreamType,
} from "@threa/types"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Drawer, DrawerContent, DrawerTitle, DrawerTrigger } from "@/components/ui/drawer"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useInputMode } from "@/hooks/use-input-mode"
import {
  useWorkspaceDmPeers,
  useWorkspaceLabels,
  useWorkspaceStreams,
  useWorkspaceUsers,
} from "@/stores/workspace-store"
import type { CachedLabel } from "@/hooks/use-labels"
import { resolveStreamName, STREAM_ICONS } from "@/lib/streams"
import { BoardSavedViews, isViewActive, type BoardViewSelection } from "@/components/board/board-saved-views"
import { useBoardViews } from "@/hooks/use-board-views"
import { boardHomeSearch, toggleExclude, toggleInclude } from "@/components/board/board-filter-params"
import { BOARD_LENS_DEFS } from "@/lib/board/lens-defs"
import { isBoardFiltered } from "@/lib/board/filter-state"
import { cn } from "@/lib/utils"

/** Stream types offered in the pickers: the board's root-stream grains (shared
 *  with the backend validator). */
const SCOPE_STREAM_TYPES = new Set<string>(BOARD_SCOPE_STREAM_TYPES)

/** Picker/chip labels per root-stream type, in `BOARD_SCOPE_STREAM_TYPES` order. */
const TYPE_LABELS: Record<BoardScopeStreamType, string> = {
  channel: "Channels",
  dm: "DMs",
  scratchpad: "Scratchpads",
  system: "System",
}

/** The lens's URL (INV-59): the viewer's home lens rests at the bare `/board`,
 *  every other lens takes a segment (so `all` gets `/board/all` when it isn't
 *  home). `search` rides along so switching lens keeps the scope (and an open
 *  panel). */
function lensHref(workspaceId: string, lens: BoardLens, search: string, homeLens: BoardLens): string {
  const base = lens === homeLens ? `/w/${workspaceId}/board` : `/w/${workspaceId}/board/${lens}`
  return `${base}${search}`
}

/** A dimension's include/exclude rewrite: both lists in one URL write. */
type FilterChange<T> = (include: T[], exclude: T[]) => void

/** Chip/row glyph: lucide icons and the `STREAM_ICONS` components both fit. */
type FilterIcon = ComponentType<{ className?: string }>

interface BoardFilterBarProps {
  workspaceId: string
  lens: BoardLens
  /** The viewer's home lens (bare `/board`) — decides which lens is segment-less
   *  and where "Clear filters" returns (the All surfacing baseline). */
  homeLens: BoardLens
  /** Included scope stream ids (root streams), in URL order. */
  scopeStreamIds: string[]
  /** Excluded stream ids (anchor-or-root veto), in URL order. */
  excludeStreamIds: string[]
  /** Rewrites the stream filter; the page owns the URL write. */
  onStreamFilterChange: FilterChange<string>
  /** Included root-stream types, in URL order. */
  scopeStreamTypes: BoardScopeStreamType[]
  /** Excluded root-stream types, in URL order. */
  excludeStreamTypes: BoardScopeStreamType[]
  /** Rewrites the type filter; the page owns the URL write. */
  onTypeFilterChange: FilterChange<BoardScopeStreamType>
  /** Included label ids (the viewer's own labels), in URL order. */
  scopeLabelIds: string[]
  /** Excluded label ids, in URL order. */
  excludeLabelIds: string[]
  /** Rewrites the label filter; the page owns the URL write. */
  onLabelFilterChange: FilterChange<string>
  /** Root streams the viewer muted from the board (board-view-design.md § "Hide & mute"). */
  mutedStreamIds?: ReadonlySet<string>
  /** Toggle a stream's board mute; the page owns the write. */
  onToggleMute?: (streamId: string, mute: boolean) => void
  /** Whether archived cards are currently included (`?archived=true`). */
  showArchived: boolean
  /** Toggle the archived opt-in; the page owns the URL write. */
  onToggleArchived: (next: boolean) => void
}

/**
 * The board's filter row: a lens picker and stream/type/label pickers, all
 * optional narrowings over the always-available All home. Deliberately a
 * filter control — not a tab strip — so the lenses read as suggestions you can
 * reach for (like the search page's stream-type filter), not as the prescribed
 * ways to use the board. Every filter lives in the URL (lens as a route
 * segment, the rest as query params), so refresh/back/share reproduce the view
 * (INV-59).
 *
 * Each picker row is tri-state: the row toggles INCLUDE (checkbox), the ban
 * button on its right toggles EXCLUDE — include narrows, exclude vetoes, and
 * the two are mutually exclusive per row. Excluded selections render as "Not:"
 * chips so a veto never reads as a scope.
 *
 * One horizontally-scrollable row on every breakpoint: controls first, then a
 * chip per selection, then a clear-all link once anything narrows. Pickers
 * open as popovers for mouse input and bottom drawers for touch (the
 * `SearchFilterMenu` split).
 */
export function BoardFilterBar({
  workspaceId,
  lens,
  homeLens,
  scopeStreamIds,
  excludeStreamIds,
  onStreamFilterChange,
  scopeStreamTypes,
  excludeStreamTypes,
  onTypeFilterChange,
  scopeLabelIds,
  excludeLabelIds,
  onLabelFilterChange,
  mutedStreamIds,
  onToggleMute,
  showArchived,
  onToggleArchived,
}: BoardFilterBarProps) {
  const location = useLocation()
  const streams = useWorkspaceStreams(workspaceId)
  const users = useWorkspaceUsers(workspaceId)
  const dmPeers = useWorkspaceDmPeers(workspaceId)
  const allLabels = useWorkspaceLabels(workspaceId)
  const myLabels = useMemo(
    () => allLabels.filter((l) => !l.archivedAt).sort((a, b) => a.name.localeCompare(b.name)),
    [allLabels]
  )
  const streamById = useMemo(() => new Map(streams.map((s) => [s.id, s])), [streams])
  const labelById = useMemo(() => new Map(myLabels.map((l) => [l.id, l])), [myLabels])

  // The viewer's home lens is their baseline, so being on it (with no scope
  // narrowing) is NOT "filtered" — otherwise a non-All home shows a permanent
  // "Clear filters" affordance on its own untouched landing view.
  const isFiltered = isBoardFiltered(homeLens, {
    lens,
    scopeStreamIds,
    scopeStreamTypes,
    scopeLabelIds,
    excludeStreamIds,
    excludeStreamTypes,
    excludeLabelIds,
  })
  const clearedSearch = useMemo(() => boardHomeSearch(location.search), [location.search])

  const labelFor = (streamId: string) =>
    resolveStreamName(streamId, { streams, users, dmPeers }, "generic") ?? "Unknown stream"
  const labelNameFor = (labelId: string) => labelById.get(labelId)?.name ?? "Unknown label"

  // The Labels picker only renders when there's something to pick (or a stale
  // URL names labels the viewer no longer has — keep it so they can clear it).
  const showLabelsPicker = myLabels.length > 0 || scopeLabelIds.length > 0 || excludeLabelIds.length > 0

  const streamIconFor = (id: string): FilterIcon => {
    const type = streamById.get(id)?.type
    return (type && STREAM_ICONS[type]) || Hash
  }

  return (
    <div className="flex min-h-9 items-center gap-1.5 overflow-x-auto border-b px-3 py-1.5 scrollbar-none sm:px-4">
      <BoardLensMenu
        workspaceId={workspaceId}
        lens={lens}
        homeLens={homeLens}
        scopeStreamIds={scopeStreamIds}
        excludeStreamIds={excludeStreamIds}
        scopeStreamTypes={scopeStreamTypes}
        excludeStreamTypes={excludeStreamTypes}
        scopeLabelIds={scopeLabelIds}
        excludeLabelIds={excludeLabelIds}
      />
      <BoardScopePicker
        workspaceId={workspaceId}
        scopeStreamIds={scopeStreamIds}
        excludeStreamIds={excludeStreamIds}
        onStreamFilterChange={onStreamFilterChange}
        labelFor={labelFor}
        mutedStreamIds={mutedStreamIds}
        onToggleMute={onToggleMute}
      />
      <BoardTypePicker
        scopeStreamTypes={scopeStreamTypes}
        excludeStreamTypes={excludeStreamTypes}
        onTypeFilterChange={onTypeFilterChange}
      />
      {showLabelsPicker && (
        <BoardLabelPicker
          myLabels={myLabels}
          scopeLabelIds={scopeLabelIds}
          excludeLabelIds={excludeLabelIds}
          onLabelFilterChange={onLabelFilterChange}
        />
      )}
      <Button
        type="button"
        variant={showArchived ? "secondary" : "outline"}
        size="sm"
        onClick={() => onToggleArchived(!showArchived)}
        aria-pressed={showArchived}
        className="h-7 shrink-0 gap-1.5 rounded-full px-2.5 text-xs font-normal"
        aria-label={showArchived ? "Hide archived conversations" : "Show archived conversations"}
      >
        <Archive className="h-3.5 w-3.5" />
        Archived
      </Button>
      {scopeStreamTypes.map((type) => (
        <FilterChip
          key={`is-${type}`}
          icon={STREAM_ICONS[type] || Layers}
          label={TYPE_LABELS[type]}
          onRemove={() =>
            onTypeFilterChange(
              scopeStreamTypes.filter((t) => t !== type),
              excludeStreamTypes
            )
          }
          removeLabel={`Remove ${TYPE_LABELS[type]} from the board scope`}
        />
      ))}
      {excludeStreamTypes.map((type) => (
        <FilterChip
          key={`not-is-${type}`}
          icon={STREAM_ICONS[type] || Layers}
          label={TYPE_LABELS[type]}
          excluded
          onRemove={() =>
            onTypeFilterChange(
              scopeStreamTypes,
              excludeStreamTypes.filter((t) => t !== type)
            )
          }
          removeLabel={`Stop excluding ${TYPE_LABELS[type]} from the board`}
        />
      ))}
      {scopeStreamIds.map((id) => (
        <FilterChip
          key={`in-${id}`}
          icon={streamIconFor(id)}
          label={labelFor(id)}
          onRemove={() =>
            onStreamFilterChange(
              scopeStreamIds.filter((s) => s !== id),
              excludeStreamIds
            )
          }
          removeLabel={`Remove ${labelFor(id)} from the board scope`}
        />
      ))}
      {excludeStreamIds.map((id) => (
        <FilterChip
          key={`not-in-${id}`}
          icon={streamIconFor(id)}
          label={labelFor(id)}
          excluded
          onRemove={() =>
            onStreamFilterChange(
              scopeStreamIds,
              excludeStreamIds.filter((s) => s !== id)
            )
          }
          removeLabel={`Stop excluding ${labelFor(id)} from the board`}
        />
      ))}
      {scopeLabelIds.map((id) => (
        <FilterChip
          key={`label-${id}`}
          icon={Tag}
          label={labelNameFor(id)}
          swatch={labelById.get(id)?.color}
          onRemove={() =>
            onLabelFilterChange(
              scopeLabelIds.filter((l) => l !== id),
              excludeLabelIds
            )
          }
          removeLabel={`Remove the ${labelNameFor(id)} label from the board scope`}
        />
      ))}
      {excludeLabelIds.map((id) => (
        <FilterChip
          key={`not-label-${id}`}
          icon={Tag}
          label={labelNameFor(id)}
          swatch={labelById.get(id)?.color}
          excluded
          onRemove={() =>
            onLabelFilterChange(
              scopeLabelIds,
              excludeLabelIds.filter((l) => l !== id)
            )
          }
          removeLabel={`Stop excluding the ${labelNameFor(id)} label from the board`}
        />
      ))}
      {isFiltered && (
        <Link
          to={lensHref(workspaceId, homeLens, clearedSearch, homeLens)}
          className="shrink-0 px-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          Clear filters
        </Link>
      )}
    </div>
  )
}

/**
 * One filter selection in the bar. An `excluded` chip reads as a veto: "Not:"
 * prefix + destructive tint, so a narrowed board and a vetoed stream can't be
 * confused at a glance.
 */
function FilterChip({
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
 * Shared container for the bar's pickers: popover for mouse input, bottom
 * drawer when a finger is active (the `SearchFilterMenu` split). One shell so
 * the pickers can't drift as sizing/a11y evolves.
 */
function FilterMenuShell({
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
 * Lens picker. Each option is a link (lens changes are navigation, INV-40) with
 * a one-line description, so the menu doubles as the explanation of what each
 * lens means. The trigger reflects the active lens and fills in once a
 * non-default lens narrows the board.
 */
function BoardLensMenu({
  workspaceId,
  lens,
  homeLens,
  scopeStreamIds,
  excludeStreamIds,
  scopeStreamTypes,
  excludeStreamTypes,
  scopeLabelIds,
  excludeLabelIds,
}: {
  workspaceId: string
  lens: BoardLens
  homeLens: BoardLens
  scopeStreamIds: string[]
  excludeStreamIds: string[]
  scopeStreamTypes: BoardScopeStreamType[]
  excludeStreamTypes: BoardScopeStreamType[]
  scopeLabelIds: string[]
  excludeLabelIds: string[]
}) {
  const [open, setOpen] = useState(false)
  const { search } = useLocation()
  const current = BOARD_LENS_DEFS[lens]
  const CurrentIcon = current.icon

  // A saved view IS the selection when the live lens + every filter axis match
  // it, so it — not its base lens — is what reads as active. Resolved once here
  // so the lens list and the saved-view list can't both mark a row.
  const { data: views } = useBoardViews(workspaceId)
  const selection: BoardViewSelection = {
    lens,
    scopeStreamIds,
    scopeStreamTypes,
    scopeLabelIds,
    excludeStreamIds,
    excludeStreamTypes,
    excludeLabelIds,
  }
  const activeViewId = views?.find((view) => isViewActive(view, selection))?.id ?? null

  const content = (
    <>
      <nav aria-label="Board lens" className="py-1">
        {BOARD_LENSES.map((value) => {
          const def = BOARD_LENS_DEFS[value]
          const Icon = def.icon
          const selected = value === lens && activeViewId === null
          return (
            <Link
              key={value}
              to={lensHref(workspaceId, value, search, homeLens)}
              onClick={() => setOpen(false)}
              aria-current={selected ? "true" : undefined}
              className={cn(
                "mx-1 flex items-start gap-2.5 rounded-item px-2.5 py-2 transition-colors hover:bg-muted",
                selected && "bg-muted/60"
              )}
            >
              <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">{def.label}</span>
                <span className="block text-xs text-muted-foreground">{def.description}</span>
              </span>
              {selected && <Check className="mt-1 h-4 w-4 shrink-0" />}
            </Link>
          )
        })}
      </nav>
      <BoardSavedViews
        workspaceId={workspaceId}
        lens={lens}
        homeLens={homeLens}
        activeViewId={activeViewId}
        scopeStreamIds={scopeStreamIds}
        excludeStreamIds={excludeStreamIds}
        scopeStreamTypes={scopeStreamTypes}
        excludeStreamTypes={excludeStreamTypes}
        scopeLabelIds={scopeLabelIds}
        excludeLabelIds={excludeLabelIds}
        onNavigate={() => setOpen(false)}
      />
    </>
  )

  const trigger = (
    <Button
      variant={lens === homeLens ? "outline" : "secondary"}
      size="sm"
      className="h-7 shrink-0 gap-1.5 rounded-full px-2.5 text-xs font-normal"
      aria-label={`Board lens: ${current.label}`}
    >
      <CurrentIcon className="h-3.5 w-3.5" />
      {current.label}
      <ChevronDown className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
    </Button>
  )

  return (
    <FilterMenuShell title="Board lens" open={open} onOpenChange={setOpen} trigger={trigger}>
      {content}
    </FilterMenuShell>
  )
}

/**
 * Stream picker: a searchable tri-state multi-select over the workspace's root
 * streams (channels, DMs, scratchpads, system). The row toggles include
 * (`?in=`), the ban toggle vetoes (`?not-in=`); both rewrite through the page.
 * Each list is capped at the shared server limit so the picker can't build a
 * URL the backend rejects.
 */
function BoardScopePicker({
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
      .filter(({ label }) => !lower || label.toLowerCase().includes(lower))
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
function BoardTypePicker({
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
function BoardLabelPicker({
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
      .filter((label) => !lower || label.name.toLowerCase().includes(lower))
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
