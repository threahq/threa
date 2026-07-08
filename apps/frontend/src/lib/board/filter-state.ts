import type { BoardLens, BoardScopeStreamType } from "@threa/types"

/** The board's live view — lens plus every filter axis — matched against a saved
 *  view to mark which one you're currently looking at, and against the viewer's
 *  home lens to decide whether the board is narrowed. */
export interface BoardViewSelection {
  lens: BoardLens
  scopeStreamIds: string[]
  scopeStreamTypes: BoardScopeStreamType[]
  scopeLabelIds: string[]
  excludeStreamIds: string[]
  excludeStreamTypes: BoardScopeStreamType[]
  excludeLabelIds: string[]
}

/** Is the board showing something narrower than the viewer's home? True when the
 *  live lens differs from home or any include/exclude axis is populated. The home
 *  lens is the baseline, so resting on it with no scope is NOT filtered — this
 *  gates the "Clear filters" chrome, the "Save current view" affordance, and the
 *  empty-state "Show everything" CTA, all of which must stay hidden on the plain
 *  landing view of a non-All home. */
export function isBoardFiltered(homeLens: BoardLens, selection: BoardViewSelection): boolean {
  return (
    selection.lens !== homeLens ||
    selection.scopeStreamIds.length > 0 ||
    selection.scopeStreamTypes.length > 0 ||
    selection.scopeLabelIds.length > 0 ||
    selection.excludeStreamIds.length > 0 ||
    selection.excludeStreamTypes.length > 0 ||
    selection.excludeLabelIds.length > 0
  )
}
