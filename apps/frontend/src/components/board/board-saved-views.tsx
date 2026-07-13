import { useEffect, useRef, useState } from "react"
import { Link } from "react-router-dom"
import { Bookmark, Check, Pencil, Pin, Plus, Trash2 } from "lucide-react"
import {
  DEFAULT_BOARD_LENS,
  MAX_BOARD_VIEW_NAME_LENGTH,
  type BoardLens,
  type BoardScopeStreamType,
  type BoardView,
} from "@threa/types"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog"
import { cn } from "@/lib/utils"
import { usePreferencesOptional } from "@/contexts"
import {
  useBoardHome,
  useBoardViews,
  useSaveBoardView,
  useUpdateBoardView,
  useDeleteBoardView,
} from "@/hooks/use-board-views"
import {
  BOARD_LENS_PARAM,
  BOARD_SCOPE_PARAM,
  BOARD_TYPE_PARAM,
  BOARD_LABEL_PARAM,
  BOARD_EXCLUDE_SCOPE_PARAM,
  BOARD_EXCLUDE_TYPE_PARAM,
  BOARD_EXCLUDE_LABEL_PARAM,
} from "@/components/board/board-filter-params"
import { isBoardFiltered, type BoardViewSelection } from "@/lib/board/filter-state"

export type { BoardViewSelection }

/** Expand a saved view into the canonical board URL it bookmarks (INV-59): the
 *  explicit `?lens=` plus its filter axes. */
export function savedViewHref(workspaceId: string, view: BoardView): string {
  const params = new URLSearchParams()
  params.set(BOARD_LENS_PARAM, view.baseLens)
  if (view.scopeStreamIds.length > 0) params.set(BOARD_SCOPE_PARAM, view.scopeStreamIds.join(","))
  if (view.scopeStreamTypes.length > 0) params.set(BOARD_TYPE_PARAM, view.scopeStreamTypes.join(","))
  if (view.scopeLabelIds.length > 0) params.set(BOARD_LABEL_PARAM, view.scopeLabelIds.join(","))
  if (view.excludeStreamIds.length > 0) params.set(BOARD_EXCLUDE_SCOPE_PARAM, view.excludeStreamIds.join(","))
  if (view.excludeStreamTypes.length > 0) params.set(BOARD_EXCLUDE_TYPE_PARAM, view.excludeStreamTypes.join(","))
  if (view.excludeLabelIds.length > 0) params.set(BOARD_EXCLUDE_LABEL_PARAM, view.excludeLabelIds.join(","))
  return `/w/${workspaceId}/board?${params.toString()}`
}

/** The lens's URL (INV-59): `?lens=` rewritten in the current search so the
 *  filter axes (and an open `?panel=`) ride along a lens switch. Sibling of
 *  {@link savedViewHref}; shared by the filter bar's lens menu and the board-mode
 *  sidebar block so the two can't drift (INV-35). */
export function lensHref(workspaceId: string, lens: BoardLens, search: string): string {
  const params = new URLSearchParams(search)
  params.set(BOARD_LENS_PARAM, lens)
  return `/w/${workspaceId}/board?${params.toString()}`
}

/** Order-independent membership equality — URL params carry no stable order, so
 *  `?in=a,b` and `?in=b,a` are the same selection. */
function sameMembers(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const set = new Set(a)
  return b.every((x) => set.has(x))
}

/** A saved view is active when the live lens and every filter axis match what it
 *  bookmarked. Archived is not part of a saved view, so it doesn't participate. */
export function isViewActive(view: BoardView, selection: BoardViewSelection): boolean {
  return (
    view.baseLens === selection.lens &&
    sameMembers(view.scopeStreamIds, selection.scopeStreamIds) &&
    sameMembers(view.scopeStreamTypes, selection.scopeStreamTypes) &&
    sameMembers(view.scopeLabelIds, selection.scopeLabelIds) &&
    sameMembers(view.excludeStreamIds, selection.excludeStreamIds) &&
    sameMembers(view.excludeStreamTypes, selection.excludeStreamTypes) &&
    sameMembers(view.excludeLabelIds, selection.excludeLabelIds)
  )
}

/** Count phrase: `3 streams`, `1 label`. */
function countOf(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`
}

/**
 * The explicit URL the bare query-less `/board` entry alias redirects to: the
 * saved-view home when the configured `boardDefaultViewId` resolves, else the
 * home lens. Always a `?lens=`-carrying URL, never the bare path — the redirect
 * cannot loop. A stale/deleted view id degrades to the home lens. Pure so the
 * landing decision is unit-testable without mounting the page.
 */
export function boardHomeHref(
  workspaceId: string,
  defaultViewId: string | null,
  views: BoardView[] | undefined,
  homeLens: BoardLens
): string {
  const view = defaultViewId ? views?.find((v) => v.id === defaultViewId) : undefined
  return view ? savedViewHref(workspaceId, view) : lensHref(workspaceId, homeLens, "")
}

/** A one-line summary of what a view filters to, under its name. */
export function summarizeBoardView(view: BoardView): string {
  const parts: string[] = []
  if (view.baseLens !== DEFAULT_BOARD_LENS) parts.push(view.baseLens.replace("-", " "))
  if (view.scopeStreamIds.length > 0) parts.push(countOf(view.scopeStreamIds.length, "stream"))
  if (view.scopeStreamTypes.length > 0) parts.push(view.scopeStreamTypes.join(", "))
  if (view.scopeLabelIds.length > 0) parts.push(countOf(view.scopeLabelIds.length, "label"))
  const vetoes: string[] = []
  if (view.excludeStreamIds.length > 0) vetoes.push(countOf(view.excludeStreamIds.length, "stream"))
  if (view.excludeStreamTypes.length > 0) vetoes.push(view.excludeStreamTypes.join(", "))
  if (view.excludeLabelIds.length > 0) vetoes.push(countOf(view.excludeLabelIds.length, "label"))
  if (vetoes.length > 0) parts.push(`not ${vetoes.join(", ")}`)
  return parts.join(" · ") || "Everything"
}

interface BoardSavedViewsProps {
  workspaceId: string
  /** The board's live filter state — captured when saving "the current view". */
  lens: BoardLens
  /** The saved view whose lens + filters match the live board, or `null`. Owned by
   *  the lens menu so the lens list and this list never both mark a row. */
  activeViewId: string | null
  scopeStreamIds: string[]
  scopeStreamTypes: BoardScopeStreamType[]
  scopeLabelIds: string[]
  excludeStreamIds: string[]
  excludeStreamTypes: BoardScopeStreamType[]
  excludeLabelIds: string[]
  /** Close the enclosing lens menu after navigating to a saved view. */
  onNavigate: () => void
}

/**
 * The "Saved views" section of the lens picker (board-view-design.md § "Lenses" —
 * "save our own lenses"). Each saved view is a `<Link>` that expands into the
 * canonical board URL (INV-40/INV-59). "Save current view" captures the board's
 * live lens + every include/exclude filter axis; rename/delete edit an existing
 * one. Success is silent — the list reflects it (INV-63).
 */
export function BoardSavedViews({
  workspaceId,
  lens,
  activeViewId,
  scopeStreamIds,
  scopeStreamTypes,
  scopeLabelIds,
  excludeStreamIds,
  excludeStreamTypes,
  excludeLabelIds,
  onNavigate,
}: BoardSavedViewsProps) {
  const { data: views } = useBoardViews(workspaceId)
  const prefs = usePreferencesOptional()
  const { view: homeView } = useBoardHome(workspaceId)
  const save = useSaveBoardView(workspaceId)
  const update = useUpdateBoardView(workspaceId)
  const remove = useDeleteBoardView(workspaceId)

  // `null` closed; `{ id: null }` = save-current; `{ id }` = rename that view.
  const [editing, setEditing] = useState<{ id: string | null; name: string } | null>(null)

  // Only offer "save current view" when there's a narrowing to bookmark that
  // isn't already bookmarked — the unfiltered baseline has nothing to save, and
  // a selection that matches an existing view (activeViewId) IS that view.
  const isFiltered =
    activeViewId === null &&
    isBoardFiltered({
      lens,
      scopeStreamIds,
      scopeStreamTypes,
      scopeLabelIds,
      excludeStreamIds,
      excludeStreamTypes,
      excludeLabelIds,
    })

  const submit = (name: string) => {
    if (editing?.id) update.mutate({ id: editing.id, input: { name } })
    else
      save.mutate({
        name,
        baseLens: lens,
        scopeStreamIds,
        scopeStreamTypes,
        scopeLabelIds,
        excludeStreamIds,
        excludeStreamTypes,
        excludeLabelIds,
      })
    setEditing(null)
  }

  return (
    <>
      {(views && views.length > 0) || isFiltered ? (
        <div className="border-t pt-1">
          <p className="px-3 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Saved views
          </p>
          {views?.map((view) => {
            const active = view.id === activeViewId
            return (
              <div
                key={view.id}
                className={cn(
                  "group mx-1 flex items-start gap-1 rounded-item px-2.5 py-2 transition-colors hover:bg-muted",
                  active && "bg-muted/60"
                )}
              >
                <Link
                  to={savedViewHref(workspaceId, view)}
                  onClick={onNavigate}
                  aria-current={active ? "true" : undefined}
                  className="flex min-w-0 flex-1 items-start gap-2.5"
                >
                  <Bookmark className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{view.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">{summarizeBoardView(view)}</span>
                  </span>
                </Link>
                {/* Pin this saved view as the board home (bare `/board` bounces to
                    it). Filled when it's the current home; silent per INV-63. */}
                <button
                  type="button"
                  onClick={() => void prefs?.updatePreferences({ boardDefaultViewId: view.id })}
                  aria-pressed={view.id === homeView?.id}
                  aria-label={
                    view.id === homeView?.id ? `${view.name} is your board home` : `Set ${view.name} as board home`
                  }
                  className={cn(
                    "mt-0.5 shrink-0 rounded p-1 transition-colors",
                    view.id === homeView?.id ? "text-foreground" : "text-muted-foreground/40 hover:text-foreground"
                  )}
                >
                  <Pin className={cn("h-3.5 w-3.5", view.id === homeView?.id && "fill-current")} />
                </button>
                {/* Right slot: the active check sits at the row's right edge (same
                    column as the lens list's check) and fades to the rename/delete
                    actions on hover/focus — one indicator, never both. */}
                <div className="relative flex shrink-0 items-start">
                  <button
                    type="button"
                    onClick={() => setEditing({ id: view.id, name: view.name })}
                    aria-label={`Rename ${view.name}`}
                    className="rounded p-1 text-muted-foreground/60 opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => remove.mutate(view.id)}
                    aria-label={`Delete ${view.name}`}
                    className="rounded p-1 text-muted-foreground/60 opacity-0 transition-opacity hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                  {active && (
                    <Check className="pointer-events-none absolute right-0 top-1 h-4 w-4 transition-opacity group-hover:opacity-0 group-focus-within:opacity-0" />
                  )}
                </div>
              </div>
            )
          })}
          {isFiltered && (
            <button
              type="button"
              onClick={() => setEditing({ id: null, name: "" })}
              className="mx-1 flex w-[calc(100%-0.5rem)] items-center gap-2.5 rounded-item px-2.5 py-2 text-left text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <Plus className="h-4 w-4 shrink-0" />
              Save current view
            </button>
          )}
        </div>
      ) : null}

      <SaveViewDialog
        open={editing !== null}
        initialName={editing?.name ?? ""}
        isRename={!!editing?.id}
        onOpenChange={(open) => !open && setEditing(null)}
        onSubmit={submit}
      />
    </>
  )
}

/**
 * Save the board's live selection as a new view, reusing the same
 * {@link SaveViewDialog} the lens menu opens (INV-35 — one dialog, no duplicate).
 * Standalone so the board-mode sidebar chips can offer "Save view" without
 * re-hosting the whole saved-views list. Silent on success (INV-63).
 */
export function SaveCurrentViewDialog({
  workspaceId,
  open,
  onOpenChange,
  selection,
}: {
  workspaceId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  selection: BoardViewSelection
}) {
  const save = useSaveBoardView(workspaceId)
  return (
    <SaveViewDialog
      open={open}
      initialName=""
      isRename={false}
      onOpenChange={onOpenChange}
      onSubmit={(name) => {
        save.mutate({
          name,
          baseLens: selection.lens,
          scopeStreamIds: selection.scopeStreamIds,
          scopeStreamTypes: selection.scopeStreamTypes,
          scopeLabelIds: selection.scopeLabelIds,
          excludeStreamIds: selection.excludeStreamIds,
          excludeStreamTypes: selection.excludeStreamTypes,
          excludeLabelIds: selection.excludeLabelIds,
        })
        onOpenChange(false)
      }}
    />
  )
}

interface SaveViewDialogProps {
  open: boolean
  initialName: string
  isRename: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (name: string) => void
}

function SaveViewDialog({ open, initialName, isRename, onOpenChange, onSubmit }: SaveViewDialogProps) {
  const [value, setValue] = useState(initialName)
  // Re-seed only on an open transition, so a concurrent update to `initialName`
  // (e.g. a rename landing via the live list) can't wipe in-progress typing.
  const wasOpen = useRef(false)
  useEffect(() => {
    if (open && !wasOpen.current) setValue(initialName)
    wasOpen.current = open
  }, [open, initialName])

  const trimmed = value.trim()
  const canSave = trimmed.length > 0 && trimmed !== initialName.trim()

  const submit = () => {
    if (!canSave) return
    onSubmit(trimmed)
  }

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>{isRename ? "Rename view" : "Save current view"}</ResponsiveDialogTitle>
        </ResponsiveDialogHeader>
        <ResponsiveDialogBody>
          <Input
            autoFocus
            value={value}
            maxLength={MAX_BOARD_VIEW_NAME_LENGTH}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault()
                submit()
              }
            }}
            placeholder="View name"
          />
        </ResponsiveDialogBody>
        <ResponsiveDialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!canSave}>
            {isRename ? "Rename" : "Save"}
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
