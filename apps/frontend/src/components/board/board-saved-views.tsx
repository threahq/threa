import { useEffect, useRef, useState } from "react"
import { Link } from "react-router-dom"
import { Bookmark, Pencil, Plus, Trash2 } from "lucide-react"
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
import { useBoardViews, useSaveBoardView, useUpdateBoardView, useDeleteBoardView } from "@/hooks/use-board-views"

const BOARD_SCOPE_PARAM = "in"
const BOARD_TYPE_PARAM = "is"

/** Expand a saved view into the canonical board URL it bookmarks (INV-59). */
export function savedViewHref(workspaceId: string, view: BoardView): string {
  const base =
    view.baseLens === DEFAULT_BOARD_LENS ? `/w/${workspaceId}/board` : `/w/${workspaceId}/board/${view.baseLens}`
  const params = new URLSearchParams()
  if (view.scopeStreamIds.length > 0) params.set(BOARD_SCOPE_PARAM, view.scopeStreamIds.join(","))
  if (view.scopeStreamTypes.length > 0) params.set(BOARD_TYPE_PARAM, view.scopeStreamTypes.join(","))
  const qs = params.toString()
  return qs ? `${base}?${qs}` : base
}

/** A one-line summary of what a view filters to, under its name. */
function summarize(view: BoardView): string {
  const parts: string[] = []
  if (view.baseLens !== DEFAULT_BOARD_LENS) parts.push(view.baseLens.replace("-", " "))
  if (view.scopeStreamIds.length > 0) {
    parts.push(`${view.scopeStreamIds.length} stream${view.scopeStreamIds.length === 1 ? "" : "s"}`)
  }
  if (view.scopeStreamTypes.length > 0) parts.push(view.scopeStreamTypes.join(", "))
  return parts.join(" · ") || "Everything"
}

interface BoardSavedViewsProps {
  workspaceId: string
  /** The board's live filter state — captured when saving "the current view". */
  lens: BoardLens
  scopeStreamIds: string[]
  scopeStreamTypes: BoardScopeStreamType[]
  /** Close the enclosing lens menu after navigating to a saved view. */
  onNavigate: () => void
}

/**
 * The "Saved views" section of the lens picker (board-view-design.md § "Lenses" —
 * "save our own lenses"). Each saved view is a `<Link>` that expands into the
 * canonical `/board/:lens?in=…&is=…` URL (INV-40/INV-59). "Save current view"
 * captures the board's live lens + scopes; rename/delete edit an existing one.
 * Success is silent — the list reflects it (INV-63).
 */
export function BoardSavedViews({
  workspaceId,
  lens,
  scopeStreamIds,
  scopeStreamTypes,
  onNavigate,
}: BoardSavedViewsProps) {
  const { data: views } = useBoardViews(workspaceId)
  const save = useSaveBoardView(workspaceId)
  const update = useUpdateBoardView(workspaceId)
  const remove = useDeleteBoardView(workspaceId)

  // `null` closed; `{ id: null }` = save-current; `{ id }` = rename that view.
  const [editing, setEditing] = useState<{ id: string | null; name: string } | null>(null)

  // Only offer "save current view" when there's actually a filter to bookmark —
  // the plain All home is nothing worth saving.
  const isFiltered = lens !== DEFAULT_BOARD_LENS || scopeStreamIds.length > 0 || scopeStreamTypes.length > 0

  const submit = (name: string) => {
    if (editing?.id) update.mutate({ id: editing.id, input: { name } })
    else save.mutate({ name, baseLens: lens, scopeStreamIds, scopeStreamTypes })
    setEditing(null)
  }

  return (
    <>
      {(views && views.length > 0) || isFiltered ? (
        <div className="border-t pt-1">
          <p className="px-3 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Saved views
          </p>
          {views?.map((view) => (
            <div
              key={view.id}
              className="group mx-1 flex items-center rounded-item pr-1 transition-colors hover:bg-muted"
            >
              <Link
                to={savedViewHref(workspaceId, view)}
                onClick={onNavigate}
                className="flex min-w-0 flex-1 items-start gap-2.5 px-2.5 py-2"
              >
                <Bookmark className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{view.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">{summarize(view)}</span>
                </span>
              </Link>
              <button
                type="button"
                onClick={() => setEditing({ id: view.id, name: view.name })}
                aria-label={`Rename ${view.name}`}
                className="shrink-0 rounded p-1 text-muted-foreground/60 opacity-0 transition-opacity hover:text-foreground focus:opacity-100 group-hover:opacity-100"
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => remove.mutate(view.id)}
                aria-label={`Delete ${view.name}`}
                className="shrink-0 rounded p-1 text-muted-foreground/60 opacity-0 transition-opacity hover:text-destructive focus:opacity-100 group-hover:opacity-100"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
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
