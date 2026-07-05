import { useEffect, useMemo, useState, type ReactNode } from "react"
import { Link, useLocation } from "react-router-dom"
import { BookMarked, Check, ChevronDown, CircleDashed, Hash, Layers, LayoutGrid, User, X, Zap } from "lucide-react"
import type { LucideIcon } from "lucide-react"
import {
  BOARD_LENSES,
  BOARD_SCOPE_STREAM_TYPES,
  DEFAULT_BOARD_LENS,
  MAX_BOARD_SCOPE_STREAMS,
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
import { useWorkspaceDmPeers, useWorkspaceStreams, useWorkspaceUsers } from "@/stores/workspace-store"
import { resolveStreamName, STREAM_ICONS } from "@/lib/streams"
import { cn } from "@/lib/utils"

export interface BoardLensDef {
  value: BoardLens
  label: string
  /** One-line answer to "what does this show?" — rendered under the label in the picker. */
  description: string
  icon: LucideIcon
}

/**
 * Display metadata per lens. The board page reuses labels for empty-state copy;
 * order of rendering follows `BOARD_LENSES`.
 */
export const BOARD_LENS_DEFS: Record<BoardLens, BoardLensDef> = {
  all: { value: "all", label: "All", description: "Everything, newest activity first", icon: LayoutGrid },
  active: { value: "active", label: "Active", description: "Still in motion — not stalled or resolved", icon: Zap },
  "needs-resolution": {
    value: "needs-resolution",
    label: "Needs resolution",
    description: "Stalled or gone quiet while unresolved",
    icon: CircleDashed,
  },
  decisions: {
    value: "decisions",
    label: "Decisions",
    description: "Settled — captured as a memo",
    icon: BookMarked,
  },
  mine: {
    value: "mine",
    label: "Mine",
    description: "Conversations you're in or mentioned in",
    icon: User,
  },
}

/** The query param carrying the board's stream scope (`?in=<id>,<id>`). */
export const BOARD_SCOPE_PARAM = "in"

/** The query param carrying the board's stream-TYPE scope (`?is=dm,channel` —
 *  the search syntax's `is:` vocabulary). */
export const BOARD_TYPE_PARAM = "is"

/**
 * The search string for a link back to the unfiltered board home: the current
 * query minus the filter params. Every "clear the filters" affordance (the
 * bar's Clear filters, the empty state's Show everything, the
 * post-from-filtered-view navigation) must route through this so clearing
 * filters never has the side effect of dropping unrelated URL state — an open
 * `?panel=` must survive.
 */
export function boardHomeSearch(search: string): string {
  const params = new URLSearchParams(search)
  params.delete(BOARD_SCOPE_PARAM)
  params.delete(BOARD_TYPE_PARAM)
  const query = params.toString()
  return query ? `?${query}` : ""
}

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

/** The lens's URL (INV-59): the default lens is the bare `/board`, others a segment.
 *  `search` rides along so switching lens keeps the scope (and an open panel). */
function lensHref(workspaceId: string, lens: BoardLens, search: string): string {
  const base = lens === DEFAULT_BOARD_LENS ? `/w/${workspaceId}/board` : `/w/${workspaceId}/board/${lens}`
  return `${base}${search}`
}

interface BoardFilterBarProps {
  workspaceId: string
  lens: BoardLens
  /** Selected scope stream ids (root streams), in URL order. */
  scopeStreamIds: string[]
  /** Rewrites the scope; the page owns the URL write. */
  onScopeChange: (streamIds: string[]) => void
  /** Selected root-stream types, in URL order. */
  scopeStreamTypes: BoardScopeStreamType[]
  /** Rewrites the type scope; the page owns the URL write. */
  onTypesChange: (types: BoardScopeStreamType[]) => void
}

/**
 * The board's filter row: a lens picker and a stream-scope picker, both
 * optional narrowings over the always-available All home. Deliberately a
 * filter control — not a tab strip — so the lenses read as suggestions you can
 * reach for (like the search page's stream-type filter), not as the prescribed
 * ways to use the board. Both filters live in the URL (lens as a route
 * segment, scope as `?in=`), so refresh/back/share reproduce the view (INV-59).
 *
 * One horizontally-scrollable row on every breakpoint: controls first, then a
 * chip per scoped stream, then a clear-all link once anything narrows. Pickers
 * open as popovers for mouse input and bottom drawers for touch (the
 * `SearchFilterMenu` split).
 */
export function BoardFilterBar({
  workspaceId,
  lens,
  scopeStreamIds,
  onScopeChange,
  scopeStreamTypes,
  onTypesChange,
}: BoardFilterBarProps) {
  const location = useLocation()
  const streams = useWorkspaceStreams(workspaceId)
  const users = useWorkspaceUsers(workspaceId)
  const dmPeers = useWorkspaceDmPeers(workspaceId)
  const streamById = useMemo(() => new Map(streams.map((s) => [s.id, s])), [streams])

  const isFiltered = lens !== DEFAULT_BOARD_LENS || scopeStreamIds.length > 0 || scopeStreamTypes.length > 0
  const clearedSearch = useMemo(() => boardHomeSearch(location.search), [location.search])

  const labelFor = (streamId: string) =>
    resolveStreamName(streamId, { streams, users, dmPeers }, "generic") ?? "Unknown stream"

  return (
    <div className="flex min-h-9 items-center gap-1.5 overflow-x-auto border-b px-3 py-1.5 scrollbar-none sm:px-4">
      <BoardLensMenu workspaceId={workspaceId} lens={lens} />
      <BoardScopePicker
        workspaceId={workspaceId}
        scopeStreamIds={scopeStreamIds}
        onScopeChange={onScopeChange}
        labelFor={labelFor}
      />
      <BoardTypePicker scopeStreamTypes={scopeStreamTypes} onTypesChange={onTypesChange} />
      {scopeStreamTypes.map((type) => {
        const Icon = STREAM_ICONS[type] || Layers
        return (
          <Badge key={type} variant="secondary" className="shrink-0 gap-1 pr-1">
            <Icon className="h-3 w-3" />
            {TYPE_LABELS[type]}
            <button
              type="button"
              className="rounded-full p-0.5 transition-colors hover:bg-foreground/10 hover:text-foreground"
              onClick={() => onTypesChange(scopeStreamTypes.filter((t) => t !== type))}
              aria-label={`Remove ${TYPE_LABELS[type]} from the board scope`}
            >
              <X className="h-3 w-3" />
            </button>
          </Badge>
        )
      })}
      {scopeStreamIds.map((id) => {
        const type = streamById.get(id)?.type
        const Icon = (type && STREAM_ICONS[type]) || Hash
        return (
          <Badge key={id} variant="secondary" className="shrink-0 gap-1 pr-1">
            <Icon className="h-3 w-3" />
            <span className="max-w-[140px] truncate">{labelFor(id)}</span>
            <button
              type="button"
              className="rounded-full p-0.5 transition-colors hover:bg-foreground/10 hover:text-foreground"
              onClick={() => onScopeChange(scopeStreamIds.filter((s) => s !== id))}
              aria-label={`Remove ${labelFor(id)} from the board scope`}
            >
              <X className="h-3 w-3" />
            </button>
          </Badge>
        )
      })}
      {isFiltered && (
        <Link
          to={`/w/${workspaceId}/board${clearedSearch}`}
          className="shrink-0 px-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          Clear filters
        </Link>
      )}
    </div>
  )
}

/**
 * Shared container for the bar's pickers: popover for mouse input, bottom
 * drawer when a finger is active (the `SearchFilterMenu` split). One shell so
 * the two pickers can't drift as sizing/a11y evolves.
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
 * Lens picker. Each option is a link (lens changes are navigation, INV-40) with
 * a one-line description, so the menu doubles as the explanation of what each
 * lens means. The trigger reflects the active lens and fills in once a
 * non-default lens narrows the board.
 */
function BoardLensMenu({ workspaceId, lens }: { workspaceId: string; lens: BoardLens }) {
  const [open, setOpen] = useState(false)
  const { search } = useLocation()
  const current = BOARD_LENS_DEFS[lens]
  const CurrentIcon = current.icon

  const content = (
    <nav aria-label="Board lens" className="py-1">
      {BOARD_LENSES.map((value) => {
        const def = BOARD_LENS_DEFS[value]
        const Icon = def.icon
        const selected = value === lens
        return (
          <Link
            key={value}
            to={lensHref(workspaceId, value, search)}
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
  )

  const trigger = (
    <Button
      variant={lens === DEFAULT_BOARD_LENS ? "outline" : "secondary"}
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
 * Stream-scope picker: a searchable multi-select over the workspace's root
 * streams (channels, DMs, scratchpads, system). Toggling rewrites `?in=`
 * through the page; selection is capped at the shared server limit so the
 * picker can't build a URL the backend rejects.
 */
function BoardScopePicker({
  workspaceId,
  scopeStreamIds,
  onScopeChange,
  labelFor,
}: {
  workspaceId: string
  scopeStreamIds: string[]
  onScopeChange: (streamIds: string[]) => void
  labelFor: (streamId: string) => string
}) {
  const isTouch = useInputMode() === "touch"
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState("")
  const streams = useWorkspaceStreams(workspaceId)
  const selected = useMemo(() => new Set(scopeStreamIds), [scopeStreamIds])
  const atCap = scopeStreamIds.length >= MAX_BOARD_SCOPE_STREAMS

  // Reopening always starts unfiltered.
  useEffect(() => {
    if (!open) setSearch("")
  }, [open])

  const entries = useMemo(() => {
    const lower = search.trim().toLowerCase()
    return streams
      .filter((s) => SCOPE_STREAM_TYPES.has(s.type))
      .filter((s) => !s.archivedAt || selected.has(s.id))
      .map((stream) => ({ stream, label: labelFor(stream.id) }))
      .filter(({ label }) => !lower || label.toLowerCase().includes(lower))
      .sort((a, b) => {
        const bySelected = Number(selected.has(b.stream.id)) - Number(selected.has(a.stream.id))
        return bySelected !== 0 ? bySelected : a.label.localeCompare(b.label)
      })
  }, [streams, search, selected, labelFor])

  const toggle = (id: string) => {
    if (selected.has(id)) onScopeChange(scopeStreamIds.filter((s) => s !== id))
    else if (!atCap) onScopeChange([...scopeStreamIds, id])
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
          aria-label="Find a stream to scope the board to"
        />
      </div>
      <div className="max-h-64 overflow-y-auto overscroll-contain py-1">
        {entries.length === 0 ? (
          <div className="px-3 py-2 text-xs text-muted-foreground">No streams match</div>
        ) : (
          entries.map(({ stream, label }) => {
            const checked = selected.has(stream.id)
            const Icon = STREAM_ICONS[stream.type]
            return (
              <button
                key={stream.id}
                type="button"
                onClick={() => toggle(stream.id)}
                aria-pressed={checked}
                disabled={!checked && atCap}
                className="mx-1 flex w-[calc(100%-0.5rem)] items-center gap-2 rounded-item px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted disabled:opacity-50"
              >
                <Checkbox checked={checked} tabIndex={-1} aria-hidden className="pointer-events-none" />
                <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="flex-1 truncate">{label}</span>
              </button>
            )
          })
        )}
        {atCap && (
          <p className="px-3 py-1.5 text-[11px] text-muted-foreground">
            Scope is limited to {MAX_BOARD_SCOPE_STREAMS} streams
          </p>
        )}
      </div>
      {scopeStreamIds.length > 0 && (
        <div className="flex justify-end border-t p-2">
          <Button size="sm" variant="ghost" onClick={() => onScopeChange([])}>
            Clear streams
          </Button>
        </div>
      )}
    </>
  )

  const trigger = (
    <Button
      variant={scopeStreamIds.length > 0 ? "secondary" : "outline"}
      size="sm"
      className="h-7 shrink-0 gap-1.5 rounded-full px-2.5 text-xs font-normal"
      aria-label="Scope the board to specific streams"
    >
      <Hash className="h-3.5 w-3.5" />
      Streams
      <ChevronDown className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
    </Button>
  )

  return (
    <FilterMenuShell title="Scope the board to streams" open={open} onOpenChange={setOpen} trigger={trigger}>
      {content}
    </FilterMenuShell>
  )
}

/**
 * Root-stream TYPE picker: a fixed multi-select over the board's root grains.
 * Matches by the conversation's effective root — a thread under a channel
 * counts as Channels — mirroring the stream-scope picker's root rule.
 */
function BoardTypePicker({
  scopeStreamTypes,
  onTypesChange,
}: {
  scopeStreamTypes: BoardScopeStreamType[]
  onTypesChange: (types: BoardScopeStreamType[]) => void
}) {
  const [open, setOpen] = useState(false)
  const selected = useMemo(() => new Set(scopeStreamTypes), [scopeStreamTypes])

  const toggle = (type: BoardScopeStreamType) => {
    if (selected.has(type)) onTypesChange(scopeStreamTypes.filter((t) => t !== type))
    else onTypesChange([...scopeStreamTypes, type])
  }

  const content = (
    <div className="py-1">
      {BOARD_SCOPE_STREAM_TYPES.map((type) => {
        const checked = selected.has(type)
        const Icon = STREAM_ICONS[type] || Layers
        return (
          <button
            key={type}
            type="button"
            onClick={() => toggle(type)}
            aria-pressed={checked}
            className="mx-1 flex w-[calc(100%-0.5rem)] items-center gap-2 rounded-item px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted"
          >
            <Checkbox checked={checked} tabIndex={-1} aria-hidden className="pointer-events-none" />
            <Icon className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="flex-1 truncate">{TYPE_LABELS[type]}</span>
          </button>
        )
      })}
    </div>
  )

  const trigger = (
    <Button
      variant={scopeStreamTypes.length > 0 ? "secondary" : "outline"}
      size="sm"
      className="h-7 shrink-0 gap-1.5 rounded-full px-2.5 text-xs font-normal"
      aria-label="Scope the board to stream types"
    >
      <Layers className="h-3.5 w-3.5" />
      Type
      <ChevronDown className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
    </Button>
  )

  return (
    <FilterMenuShell title="Scope the board to stream types" open={open} onOpenChange={setOpen} trigger={trigger}>
      {content}
    </FilterMenuShell>
  )
}
