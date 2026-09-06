import { useEffect, useRef, useState } from "react"
import { DEFAULT_BOARD_LENS, MAX_BOARD_VIEW_NAME_LENGTH, type BoardLens, type BoardView } from "@threahq/types"
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
import { useSaveBoardView } from "@/hooks/use-board-views"
import {
  BOARD_LENS_PARAM,
  BOARD_SCOPE_PARAM,
  BOARD_TYPE_PARAM,
  BOARD_LABEL_PARAM,
  BOARD_EXCLUDE_SCOPE_PARAM,
  BOARD_EXCLUDE_TYPE_PARAM,
  BOARD_EXCLUDE_LABEL_PARAM,
} from "@/components/board/board-filter-params"
import type { BoardViewSelection } from "@/lib/board/filter-state"

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
 *  {@link savedViewHref}; shared by the board-mode sidebar block's lens list so
 *  the two can't drift (INV-35). */
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

/**
 * Save the board's live selection as a new view, reusing the same
 * {@link SaveViewDialog} the rename flow opens (INV-35 — one dialog, no
 * duplicate). Used by the board-mode sidebar chips' "Save view". Silent on
 * success (INV-63).
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

/** The name prompt shared by "Save current view" and a view rename (INV-35). */
export function SaveViewDialog({ open, initialName, isRename, onOpenChange, onSubmit }: SaveViewDialogProps) {
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
