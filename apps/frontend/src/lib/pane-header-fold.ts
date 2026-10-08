/** Room the title (or tab row) keeps before the header folds any control. */
export const PANE_TITLE_MIN_WIDTH = 120

export interface FoldableControl<Id extends string> {
  id: Id
  /** Room the header gains when this control folds, gap included. */
  width: number
}

/**
 * Which controls fold, in the order given, so the always-shown controls and the
 * title's minimum fit in `headerWidth`. An unmeasured header (0) folds nothing.
 */
export function foldHeaderControls<Id extends string>(
  headerWidth: number,
  fixedWidth: number,
  controls: FoldableControl<Id>[]
): Set<Id> {
  const folded = new Set<Id>()
  if (headerWidth <= 0) return folded
  let needed = fixedWidth + PANE_TITLE_MIN_WIDTH + controls.reduce((sum, control) => sum + control.width, 0)
  for (const control of controls) {
    if (needed <= headerWidth) break
    folded.add(control.id)
    needed -= control.width
  }
  return folded
}
