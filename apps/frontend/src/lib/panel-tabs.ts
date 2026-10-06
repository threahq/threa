/**
 * The panel's tabs as they live in `?panel=`: ids joined by `.`, the active one
 * marked with a trailing `*`. The marker is written only when the active tab is
 * not the last, so a single panel (`?panel=stream_x`) reads exactly as it always
 * has and every arrangement has one spelling — history entries compare by URL.
 */
export interface PanelTabs {
  ids: readonly string[]
  active: string | null
}

export const PANEL_PARAM = "panel"
const SEPARATOR = "."
const ACTIVE_MARK = "*"

export const NO_PANEL_TABS: PanelTabs = { ids: [], active: null }

export function parsePanelTabs(value: string | null): PanelTabs {
  if (!value) return NO_PANEL_TABS
  const ids: string[] = []
  let active: string | null = null
  for (const part of value.split(SEPARATOR)) {
    const marked = part.endsWith(ACTIVE_MARK)
    const id = marked ? part.slice(0, -ACTIVE_MARK.length) : part
    if (!id || ids.includes(id)) continue
    ids.push(id)
    if (marked && active === null) active = id
  }
  if (ids.length === 0) return NO_PANEL_TABS
  return { ids, active: active ?? ids[ids.length - 1] }
}

export function formatPanelTabs(tabs: PanelTabs): string | null {
  if (tabs.ids.length === 0) return null
  const last = tabs.ids[tabs.ids.length - 1]
  return tabs.ids.map((id) => (id === tabs.active && id !== last ? `${id}${ACTIVE_MARK}` : id)).join(SEPARATOR)
}

/** Activates `id`, appending it after the others when it isn't open yet. */
export function openPanelTab(tabs: PanelTabs, id: string): PanelTabs {
  return { ids: tabs.ids.includes(id) ? tabs.ids : [...tabs.ids, id], active: id }
}

export function activatePanelTab(tabs: PanelTabs, id: string): PanelTabs {
  return tabs.ids.includes(id) ? { ids: tabs.ids, active: id } : tabs
}

/** Removes `id`. Closing the active tab hands focus to the tab that slides into
 *  its place, or to the new last tab when it was the last. */
export function closePanelTab(tabs: PanelTabs, id: string): PanelTabs {
  const index = tabs.ids.indexOf(id)
  if (index === -1) return tabs
  const ids = tabs.ids.filter((tabId) => tabId !== id)
  if (ids.length === 0) return NO_PANEL_TABS
  if (tabs.active !== id) return { ids, active: tabs.active }
  return { ids, active: ids[Math.min(index, ids.length - 1)] }
}

/** The tab showing `from` shows `to` instead, keeping its place and whether it
 *  is active. When `to` is already open in another tab, that tab takes over
 *  and `from` closes: an id is open at most once. */
export function replacePanelTab(tabs: PanelTabs, from: string, to: string): PanelTabs {
  if (from === to) return tabs
  if (!tabs.ids.includes(from)) return openPanelTab(tabs, to)
  if (tabs.ids.includes(to)) return { ids: tabs.ids.filter((id) => id !== from), active: to }
  return {
    ids: tabs.ids.map((id) => (id === from ? to : id)),
    active: tabs.active === from ? to : tabs.active,
  }
}
