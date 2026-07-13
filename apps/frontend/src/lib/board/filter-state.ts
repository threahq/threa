import { DEFAULT_BOARD_LENS, type BoardLens, type BoardScopeStreamType } from "@threa/types"

/** The board's live view — lens plus every filter axis — matched against a saved
 *  view to mark which one you're currently looking at, and against the unfiltered
 *  baseline to decide whether the board is narrowed. */
export interface BoardViewSelection {
  lens: BoardLens
  scopeStreamIds: string[]
  scopeStreamTypes: BoardScopeStreamType[]
  scopeLabelIds: string[]
  excludeStreamIds: string[]
  excludeStreamTypes: BoardScopeStreamType[]
  excludeLabelIds: string[]
}

/** Is the board showing something narrower than everything? True when the lens
 *  isn't the default `all` or any include/exclude axis is populated. The baseline
 *  is absolute — the unfiltered All lens — NOT the viewer's home: a saved-view or
 *  non-All home is itself a narrowing, and treating it as the baseline is what
 *  made its filters unclearable (no Clear affordance, and clearing bounced back).
 *  Gates the "Clear filters" chrome, the "Save current view" affordance, and the
 *  empty-state "Show everything" CTA. */
export function isBoardFiltered(selection: BoardViewSelection): boolean {
  return (
    selection.lens !== DEFAULT_BOARD_LENS ||
    selection.scopeStreamIds.length > 0 ||
    selection.scopeStreamTypes.length > 0 ||
    selection.scopeLabelIds.length > 0 ||
    selection.excludeStreamIds.length > 0 ||
    selection.excludeStreamTypes.length > 0 ||
    selection.excludeLabelIds.length > 0
  )
}
