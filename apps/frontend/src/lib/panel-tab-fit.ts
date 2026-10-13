/** The narrowest a tab other than the one on show gets before tabs start folding into the "+N" menu. */
export const MIN_TAB_WIDTH = 96
/** The "+N" menu trigger's footprint. */
export const MORE_TABS_WIDTH = 48
/** The "Tab actions" trigger's footprint, the header's gap before it included. */
export const TAB_ACTIONS_WIDTH = 36

/** The room a row of `tabs` needs to show two of them, beside "+N" when more are folded. */
export function tabRowReserve(tabs: number): number {
  return Math.min(tabs, 2) * MIN_TAB_WIDTH + (tabs > 2 ? MORE_TABS_WIDTH : 0)
}

export interface PanelTabFit {
  labels: boolean
  /** How many tabs show in the row; the rest are in the "+N" menu. */
  visible: number
  /** Too narrow for a whole tab beside "+N": the row drops "Tab actions" and the tab's own close, which the pane's repeat. */
  compact: boolean
}

/**
 * Fits a section's tab row into `room`, the width shared by the tabs, the
 * labels beside them and "Tab actions". The labels show only while every tab does, with the tab
 * on show at its full `activeWidth` and the others at {@link MIN_TAB_WIDTH}.
 * Past that, every tab, the one on show included, may shrink to the minimum
 * and trailing tabs fold, so how many show never depends on which tab is on show.
 */
export function fitPanelTabs(
  room: number,
  tabs: number,
  activeWidth: number,
  labelsWidth: number,
  actionsWidth = 0
): PanelTabFit {
  const tabRoom = room - actionsWidth
  const labels = activeWidth + (tabs - 1) * MIN_TAB_WIDTH + labelsWidth <= tabRoom
  if (labels || tabs * MIN_TAB_WIDTH <= tabRoom) return { labels, visible: tabs, compact: false }
  const fitting = Math.floor((tabRoom - MORE_TABS_WIDTH) / MIN_TAB_WIDTH)
  return { labels: false, visible: Math.max(1, Math.min(tabs - 1, fitting)), compact: fitting < 1 }
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
