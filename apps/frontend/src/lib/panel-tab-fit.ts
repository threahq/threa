/** The narrowest a tab other than the one on show gets before tabs start folding into the "+N" menu. */
export const MIN_TAB_WIDTH = 96
/** The "+N" menu trigger's footprint. */
export const MORE_TABS_WIDTH = 48
/** The Focus button's footprint (`w-8`). */
export const FOCUS_TOGGLE_WIDTH = 32

export interface PanelTabFit {
  labels: boolean
  focus: boolean
  /** How many tabs show in the row; the rest are in the "+N" menu. */
  visible: number
}

/**
 * Fits a section's tab row into `room`, the width shared by the tabs, the
 * labels beside them and the Focus button. The tab on show keeps its full
 * width and the others shrink to {@link MIN_TAB_WIDTH}; past that the labels
 * fold first, then the Focus button, then trailing tabs, down to the one on show.
 */
export function fitPanelTabs(
  room: number,
  tabs: number,
  activeWidth: number,
  labelsWidth: number,
  focusWidth: number
): PanelTabFit {
  const need = activeWidth + (tabs - 1) * MIN_TAB_WIDTH
  if (need + labelsWidth + focusWidth <= room) return { labels: true, focus: true, visible: tabs }
  if (need + focusWidth <= room) return { labels: false, focus: true, visible: tabs }
  if (need <= room) return { labels: false, focus: false, visible: tabs }
  const others = Math.floor((room - MORE_TABS_WIDTH - activeWidth) / MIN_TAB_WIDTH)
  return { labels: false, focus: false, visible: Math.max(1, Math.min(tabs - 1, others + 1)) }
}

/** The tabs a row of `visible` shows, in order, with the one on show always among them, and the rest. */
export function splitVisibleTabs(
  ids: readonly string[],
  active: string | null,
  visible: number
): { shown: string[]; folded: string[] } {
  const shown = ids.slice(0, visible)
  if (active !== null && ids.includes(active) && !shown.includes(active)) shown[visible - 1] = active
  return { shown, folded: ids.filter((id) => !shown.includes(id)) }
}
