import { useMemo, useState } from "react"
import { Link, useLocation, useSearchParams } from "react-router-dom"
import { Archive, Bookmark, Check, CircleDot, MoreHorizontal, Pencil, Pin, Trash2 } from "lucide-react"
import { BOARD_LENSES, type BoardLens, type BoardScopeStreamType } from "@threa/types"
import { useSidebar, usePreferencesOptional } from "@/contexts"
import { cn } from "@/lib/utils"
import { useBoardHome, useBoardViews, useDeleteBoardView, useUpdateBoardView } from "@/hooks/use-board-views"
import { useBoardSelection } from "@/hooks/use-board-selection"
import { useMuteStream, useUnmuteStream } from "@/hooks/use-conversations"
import {
  useWorkspaceDmPeers,
  useWorkspaceLabels,
  useWorkspaceStreams,
  useWorkspaceUsers,
} from "@/stores/workspace-store"
import { useBoardMutedStreamIds } from "@/stores/board-exclusions-store"
import { resolveStreamName } from "@/lib/streams"
import { isViewActive, lensHref, savedViewHref, SaveViewDialog } from "@/components/board/board-saved-views"
import {
  BoardScopePicker,
  BoardTypePicker,
  BoardLabelPicker,
  type FilterIcon,
} from "@/components/board/board-filter-pickers"
import {
  BOARD_ARCHIVED_ON,
  BOARD_ARCHIVED_PARAM,
  BOARD_EXCLUDE_LABEL_PARAM,
  BOARD_EXCLUDE_SCOPE_PARAM,
  BOARD_EXCLUDE_TYPE_PARAM,
  BOARD_LABEL_PARAM,
  BOARD_SCOPE_PARAM,
  BOARD_TYPE_PARAM,
  BOARD_UNREAD_ON,
  BOARD_UNREAD_PARAM,
  parseLensParam,
} from "@/components/board/board-filter-params"
import { BOARD_LENS_DEFS } from "@/lib/board/lens-defs"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { BoardFilterChips } from "./board-filter-chips"

interface BoardModeBlockProps {
  workspaceId: string
  /** Per-lens workspace topic totals for the Lenses row counts, from the sidebar's
   *  single stats pass; `null`/absent while it resolves (render no count). */
  lensTotals?: Record<BoardLens, number> | null
}

const ROW_CLASS = "flex items-center gap-2.5 rounded-lg px-4 py-2 text-sm font-medium transition-colors"
const SECTION_LABEL_CLASS =
  "m-0 px-4 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"

/**
 * The board block sits below the quick links in the sidebar while on `/board`
 * (board-centered-sidebar-exploration.md § V2 top blocks). Top-to-
 * bottom: the Filters group (the stream/type/label
 * pickers + the unread/archived toggles the deleted filter header used to host),
 * the active-filter chips, the viewer's saved Views, and the board Lenses. Every
 * navigational entry is a `<Link>` — the board's whole state is URL
 * (INV-40/INV-59) — built with the same helpers the pickers use
 * (`lensHref`, `savedViewHref`) so the surfaces can't drift (INV-35).
 */
export function BoardModeBlock({ workspaceId, lensTotals }: BoardModeBlockProps) {
  const { collapseOnMobile } = useSidebar()
  const location = useLocation()
  const prefs = usePreferencesOptional()

  // One shared URL derivation (INV-35) — the chips block and filters read it too.
  const { currentLens, selection } = useBoardSelection()

  const { data: views } = useBoardViews(workspaceId)
  const { view: homeView } = useBoardHome(workspaceId)
  const update = useUpdateBoardView(workspaceId)
  const remove = useDeleteBoardView(workspaceId)

  // `null` closed; `{ id, name }` = renaming that view.
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null)

  // A saved view IS the selection when the live lens + every axis match it, so it
  // — not its base lens — reads as active; a lens is active only when no view is.
  const activeViewId = views?.find((view) => isViewActive(view, selection))?.id ?? null

  const sortedViews = useMemo(() => (views ? [...views].sort((a, b) => a.sortOrder - b.sortOrder) : []), [views])

  const hasActiveFilters =
    selection.scopeStreamIds.length > 0 ||
    selection.scopeStreamTypes.length > 0 ||
    selection.scopeLabelIds.length > 0 ||
    selection.excludeStreamIds.length > 0 ||
    selection.excludeStreamTypes.length > 0 ||
    selection.excludeLabelIds.length > 0

  // No lens reads as home while a saved-view home resolves (the view's pin is home).
  const homeLens = parseLensParam(prefs?.preferences?.boardDefaultLens ?? null)
  const homeViewActive = homeView != null

  return (
    <div className="mb-2 space-y-1">
      <BoardModeFilters workspaceId={workspaceId} />

      {hasActiveFilters && <BoardFilterChips workspaceId={workspaceId} />}

      {sortedViews.length > 0 && (
        <div className="pt-1">
          {/* No count: a saved view is an arbitrary scope/type/label/lens predicate,
              not a single lens total, so the sidebar's one-pass stats can't derive it
              (see Piece 4 "where computable"). Lens rows below do get counts. */}
          <h3 className={SECTION_LABEL_CLASS}>Views</h3>
          {sortedViews.map((view) => {
            const active = view.id === activeViewId
            const isHome = view.id === homeView?.id
            return (
              <div
                key={view.id}
                className={cn(
                  "group flex items-center rounded-lg pr-2 transition-colors",
                  active ? "bg-primary/10" : "hover:bg-muted/50"
                )}
              >
                <Link
                  to={savedViewHref(workspaceId, view)}
                  onClick={collapseOnMobile}
                  aria-current={active ? "true" : undefined}
                  className={cn(
                    "flex min-w-0 flex-1 items-center gap-2.5 py-2 pl-4 text-sm font-medium",
                    !active && "text-muted-foreground"
                  )}
                >
                  {isHome ? (
                    <Pin className="h-4 w-4 shrink-0 fill-current" aria-label="Board home" />
                  ) : (
                    <Bookmark className="h-4 w-4 shrink-0" />
                  )}
                  <span className="min-w-0 flex-1 truncate">{view.name}</span>
                </Link>
                {/* Faint-but-visible resting state (same treatment as the lens
                    pin below): the sidebar is the ONLY surface managing views
                    now, and touch has no hover to reveal a hidden trigger.
                    Fixed footprint per INV-21. Management verbs are actions,
                    not navigation. */}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      aria-label={`Actions for ${view.name}`}
                      className="shrink-0 rounded p-1.5 text-muted-foreground/40 transition-colors hover:text-foreground focus-visible:text-foreground group-hover:text-muted-foreground data-[state=open]:text-foreground"
                    >
                      <MoreHorizontal className="h-4 w-4" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => void prefs?.updatePreferences({ boardDefaultViewId: view.id })}>
                      <Pin className={cn("mr-2 h-4 w-4", isHome && "fill-current")} />
                      {isHome ? "Board home" : "Set as board home"}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setRenaming({ id: view.id, name: view.name })}>
                      <Pencil className="mr-2 h-4 w-4" />
                      Rename
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => remove.mutate(view.id)}
                      className="text-destructive focus:text-destructive"
                    >
                      <Trash2 className="mr-2 h-4 w-4" />
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            )
          })}
        </div>
      )}

      <div className="pt-1">
        <h3 className={SECTION_LABEL_CLASS}>Lenses</h3>
        {BOARD_LENSES.map((value) => {
          const def = BOARD_LENS_DEFS[value]
          const Icon = def.icon
          const active = value === currentLens && activeViewId === null
          const count = lensTotals?.[value] ?? null
          const isHome = !homeViewActive && value === homeLens
          return (
            <div
              key={value}
              className={cn(
                "group flex items-center rounded-lg pr-2 transition-colors",
                active ? "bg-primary/10" : "hover:bg-muted/50"
              )}
            >
              <Link
                to={lensHref(workspaceId, value, location.search)}
                onClick={collapseOnMobile}
                aria-current={active ? "true" : undefined}
                className={cn(
                  "flex min-w-0 flex-1 items-center gap-2.5 py-2 pl-4 text-sm font-medium",
                  !active && "text-muted-foreground"
                )}
              >
                <Icon className="h-4 w-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{def.label}</span>
                {count !== null && (
                  <span aria-hidden className="shrink-0 text-xs tabular-nums text-muted-foreground">
                    {count}
                  </span>
                )}
              </Link>
              {/* Always laid out, faint until home — pinning a lens as the board
                  home mirrors the appearance-settings radio; silent per INV-63
                  (the fill is the signal), fixed footprint per INV-21. */}
              <button
                type="button"
                onClick={() => void prefs?.updatePreferences({ boardDefaultLens: value, boardDefaultViewId: null })}
                aria-pressed={isHome}
                aria-label={isHome ? `${def.label} is your board home` : `Set ${def.label} as board home`}
                className={cn(
                  "ml-1 shrink-0 rounded p-1 transition-colors",
                  isHome ? "text-foreground" : "text-muted-foreground/40 hover:text-foreground"
                )}
              >
                <Pin className={cn("h-3.5 w-3.5", isHome && "fill-current")} />
              </button>
            </div>
          )
        })}
      </div>

      <SaveViewDialog
        open={renaming !== null}
        initialName={renaming?.name ?? ""}
        isRename
        onOpenChange={(open) => !open && setRenaming(null)}
        onSubmit={(name) => {
          if (renaming) update.mutate({ id: renaming.id, input: { name } })
          setRenaming(null)
        }}
      />
    </div>
  )
}

/**
 * The board-mode "Filters" group: the stream/type/label pickers (the same
 * components the deleted filter header hosted, popover on desktop / drawer on
 * touch via `FilterMenuShell`) plus the unread-only and archived toggles. Every
 * control rewrites the board's URL params (INV-59) — the sidebar holds no filter
 * state, it just navigates. Filter rewrites `replace`, so toggling doesn't spam
 * history. Shares the URL vocabulary SSOT (`board-filter-params`) with the page.
 */
function BoardModeFilters({ workspaceId }: { workspaceId: string }) {
  const [searchParams, setSearchParams] = useSearchParams()
  const { selection } = useBoardSelection()

  const streams = useWorkspaceStreams(workspaceId)
  const users = useWorkspaceUsers(workspaceId)
  const dmPeers = useWorkspaceDmPeers(workspaceId)
  const allLabels = useWorkspaceLabels(workspaceId)
  const myLabels = useMemo(
    () => allLabels.filter((l) => !l.archivedAt).sort((a, b) => a.name.localeCompare(b.name)),
    [allLabels]
  )

  const muted = useBoardMutedStreamIds(workspaceId)
  const muteStream = useMuteStream(workspaceId)
  const unmuteStream = useUnmuteStream(workspaceId)

  const showArchived = searchParams.get(BOARD_ARCHIVED_PARAM) === BOARD_ARCHIVED_ON
  const unreadOnly = searchParams.get(BOARD_UNREAD_PARAM) === BOARD_UNREAD_ON

  const labelFor = (streamId: string) =>
    resolveStreamName(streamId, { streams, users, dmPeers }, "generic") ?? "Unknown stream"

  // The Labels picker only renders when there's something to pick (or a stale URL
  // names labels the viewer no longer has — keep it so they can clear it).
  const showLabelsPicker =
    myLabels.length > 0 || selection.scopeLabelIds.length > 0 || selection.excludeLabelIds.length > 0

  // One URL write per toggle: a dimension's include/exclude params rewrite
  // together so moving an id between the two sides is a single history entry.
  const setParamLists = (entries: Array<[param: string, values: string[]]>) => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        for (const [param, values] of entries) {
          if (values.length > 0) next.set(param, values.join(","))
          else next.delete(param)
        }
        return next
      },
      { replace: true }
    )
  }
  const setStreamFilter = (include: string[], exclude: string[]) =>
    setParamLists([
      [BOARD_SCOPE_PARAM, include],
      [BOARD_EXCLUDE_SCOPE_PARAM, exclude],
    ])
  const setTypeFilter = (include: BoardScopeStreamType[], exclude: BoardScopeStreamType[]) =>
    setParamLists([
      [BOARD_TYPE_PARAM, include],
      [BOARD_EXCLUDE_TYPE_PARAM, exclude],
    ])
  const setLabelFilter = (include: string[], exclude: string[]) =>
    setParamLists([
      [BOARD_LABEL_PARAM, include],
      [BOARD_EXCLUDE_LABEL_PARAM, exclude],
    ])

  return (
    <div className="pt-1">
      <h3 className={SECTION_LABEL_CLASS}>Filters</h3>
      <div className="flex flex-wrap items-center gap-1.5 px-4 py-1">
        <BoardScopePicker
          workspaceId={workspaceId}
          scopeStreamIds={selection.scopeStreamIds}
          excludeStreamIds={selection.excludeStreamIds}
          onStreamFilterChange={setStreamFilter}
          labelFor={labelFor}
          mutedStreamIds={muted}
          onToggleMute={(streamId, mute) => (mute ? muteStream.mutate(streamId) : unmuteStream.mutate(streamId))}
        />
        <BoardTypePicker
          scopeStreamTypes={selection.scopeStreamTypes}
          excludeStreamTypes={selection.excludeStreamTypes}
          onTypeFilterChange={setTypeFilter}
        />
        {showLabelsPicker && (
          <BoardLabelPicker
            myLabels={myLabels}
            scopeLabelIds={selection.scopeLabelIds}
            excludeLabelIds={selection.excludeLabelIds}
            onLabelFilterChange={setLabelFilter}
          />
        )}
      </div>
      <FilterToggleRow
        icon={CircleDot}
        label="Unread only"
        active={unreadOnly}
        onToggle={() => setParamLists([[BOARD_UNREAD_PARAM, unreadOnly ? [] : [BOARD_UNREAD_ON]]])}
      />
      <FilterToggleRow
        icon={Archive}
        label="Archived"
        active={showArchived}
        onToggle={() => setParamLists([[BOARD_ARCHIVED_PARAM, showArchived ? [] : [BOARD_ARCHIVED_ON]]])}
      />
    </div>
  )
}

/** A full-width on/off filter toggle styled like the board-mode nav rows. The
 *  URL param it reflects is the source of truth (INV-59); it's an action, not a
 *  navigation, so a button (INV-40). */
function FilterToggleRow({
  icon: Icon,
  label,
  active,
  onToggle,
}: {
  icon: FilterIcon
  label: string
  active: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={active}
      className={cn(ROW_CLASS, "w-full", active ? "bg-primary/10" : "text-muted-foreground hover:bg-muted/50")}
    >
      <Icon className="h-4 w-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      {active && <Check className="h-4 w-4 shrink-0" />}
    </button>
  )
}
