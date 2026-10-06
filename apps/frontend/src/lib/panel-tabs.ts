/**
 * The panel's arrangement as it lives in `?panel=`: columns of sections, each
 * section a stack of tabs. Tabs are joined by `.` with the one on show marked by
 * a trailing `*`, sections by `-`, and a section stacked under the one before it
 * in the same column by `--`. The marker is written only when the active tab is
 * not its section's last; the focused tab, floating over the rest, is marked
 * `**` wherever it is, so a single panel (`?panel=stream_x`) and an S2a tab
 * row read exactly as they always have, and every arrangement has one spelling —
 * history entries compare by URL. `-` and `.` are left alone by URL encoding and
 * never occur in a panel id.
 */
export interface PanelSection {
  ids: readonly string[]
  active: string
}

type PanelColumn = readonly PanelSection[]

export interface PanelLayout {
  columns: readonly PanelColumn[]
  /** The tab floating over the rest, always its section's active tab. Bringing
   *  another tab forward or opening one puts it back; closing or swapping out
   *  another leaves it floating. */
  focused?: string
}

export type SplitDirection = "right" | "down"

export const PANEL_PARAM = "panel"
const TAB_SEPARATOR = "."
const SECTION_SEPARATOR = "-"
const ACTIVE_MARK = "*"
const FOCUS_MARK = "**"

export const NO_PANELS: PanelLayout = { columns: [] }

export function parsePanelLayout(value: string | null): PanelLayout {
  if (!value) return NO_PANELS
  const seen = new Set<string>()
  const focus: { id: string | null } = { id: null }
  const columns: PanelSection[][] = []
  let stackNext = false
  for (const token of value.split(SECTION_SEPARATOR)) {
    if (token === "") {
      stackNext = columns.length > 0
      continue
    }
    const section = parseSection(token, seen, focus)
    if (!section) {
      stackNext = false
      continue
    }
    if (stackNext) columns[columns.length - 1].push(section)
    else columns.push([section])
    stackNext = false
  }
  if (columns.length === 0) return NO_PANELS
  return focus.id === null ? { columns } : { columns, focused: focus.id }
}

function parseSection(token: string, seen: Set<string>, focus: { id: string | null }): PanelSection | null {
  const ids: string[] = []
  let active: string | null = null
  let focused: string | null = null
  for (const part of token.split(TAB_SEPARATOR)) {
    const mark = [FOCUS_MARK, ACTIVE_MARK].find((candidate) => part.endsWith(candidate)) ?? ""
    const id = part.slice(0, part.length - mark.length)
    if (!id || seen.has(id)) continue
    seen.add(id)
    ids.push(id)
    if (mark === FOCUS_MARK && focus.id === null) focus.id = focused = id
    else if (mark !== "" && active === null) active = id
  }
  if (ids.length === 0) return null
  return { ids, active: focused ?? active ?? ids[ids.length - 1] }
}

export function formatPanelLayout(layout: PanelLayout): string | null {
  if (layout.columns.length === 0) return null
  return layout.columns
    .map((column) => column.map((section) => formatSection(section, layout.focused)).join(SECTION_SEPARATOR.repeat(2)))
    .join(SECTION_SEPARATOR)
}

function formatSection(section: PanelSection, focused: string | undefined): string {
  const last = section.ids[section.ids.length - 1]
  return section.ids
    .map((id) => {
      if (id !== section.active) return id
      if (id === focused) return `${id}${FOCUS_MARK}`
      return id === last ? id : `${id}${ACTIVE_MARK}`
    })
    .join(TAB_SEPARATOR)
}

export function panelIdsOf(layout: PanelLayout): string[] {
  return layout.columns.flatMap((column) => column.flatMap((section) => section.ids))
}

/** The tab on show in the first section: where the main view opens panels, and
 *  what a consumer outside any one tab means by "the panel". */
export function primaryPanelOf(layout: PanelLayout): string | null {
  return layout.columns[0]?.[0]?.active ?? null
}

/** The tab on show in the last section: the one most recently opened beside another. */
export function newestPanelOf(layout: PanelLayout): string | null {
  return layout.columns.at(-1)?.at(-1)?.active ?? null
}

interface PanelLocation {
  column: number
  row: number
}

function locate(layout: PanelLayout, id: string): PanelLocation | null {
  for (const [column, sections] of layout.columns.entries()) {
    const row = sections.findIndex((section) => section.ids.includes(id))
    if (row !== -1) return { column, row }
  }
  return null
}

function sectionAt(layout: PanelLayout, at: PanelLocation): PanelSection {
  return layout.columns[at.column][at.row]
}

function withSection(layout: PanelLayout, at: PanelLocation, section: PanelSection): PanelLayout {
  return {
    columns: layout.columns.map((sections, column) =>
      column === at.column ? sections.map((current, row) => (row === at.row ? section : current)) : sections
    ),
  }
}

function insertColumn(layout: PanelLayout, index: number, section: PanelSection): PanelLayout {
  return { columns: [...layout.columns.slice(0, index), [section], ...layout.columns.slice(index)] }
}

/** Floats `id` over the rest, bringing it to the front of its section; null puts it back. */
export function focusPanelTab(layout: PanelLayout, id: string | null): PanelLayout {
  if (id === layout.focused || (id !== null && !locate(layout, id))) return layout
  if (id === null) return { columns: layout.columns }
  return { columns: activatePanelTab(layout, id).columns, focused: id }
}

export function activatePanelTab(layout: PanelLayout, id: string): PanelLayout {
  const at = locate(layout, id)
  if (!at) return layout
  const section = sectionAt(layout, at)
  if (section.active !== id) return withSection(layout, at, { ids: section.ids, active: id })
  return layout.focused === undefined || layout.focused === id ? layout : { columns: layout.columns }
}

/** `next` with `prev`'s focused tab still floating, when it is still on show. */
function keepFocus(prev: PanelLayout, next: PanelLayout, focused = prev.focused): PanelLayout {
  return focused !== undefined && isPanelOnShow(next, focused) ? { ...next, focused } : next
}

function appendTab(layout: PanelLayout, at: PanelLocation, id: string): PanelLayout {
  return withSection(layout, at, { ids: [...sectionAt(layout, at).ids, id], active: id })
}

/** Opening from the main view: activates `id` where it is, or adds it as a tab of the first section. */
export function openPanelTab(layout: PanelLayout, id: string): PanelLayout {
  if (locate(layout, id)) return activatePanelTab(layout, id)
  if (layout.columns.length === 0) return { columns: [[{ ids: [id], active: id }]] }
  return appendTab(layout, { column: 0, row: 0 }, id)
}

/**
 * Opening from inside the tab `from`: activates `id` where it is, or adds it to
 * the top section of the column to the right of `from`'s, splitting a new
 * column off there when there is none.
 */
export function openPanelTabBeside(layout: PanelLayout, from: string, id: string): PanelLayout {
  if (locate(layout, id)) return activatePanelTab(layout, id)
  const at = locate(layout, from)
  if (!at) return openPanelTab(layout, id)
  const right = at.column + 1
  if (right < layout.columns.length) return appendTab(layout, { column: right, row: 0 }, id)
  return insertColumn(layout, right, { ids: [id], active: id })
}

/** Activates `id` where it is, or adds it as a tab of the section holding `of`. */
export function openPanelTabWith(layout: PanelLayout, of: string | null, id: string): PanelLayout {
  if (locate(layout, id)) return activatePanelTab(layout, id)
  const at = of ? locate(layout, of) : null
  return at ? appendTab(layout, at, id) : openPanelTab(layout, id)
}

function removeTab(layout: PanelLayout, at: PanelLocation, id: string): PanelLayout {
  const section = sectionAt(layout, at)
  const index = section.ids.indexOf(id)
  const ids = section.ids.filter((tabId) => tabId !== id)
  if (ids.length > 0) {
    // Closing the active tab hands the section to the tab that slides into its
    // place, or to the new last tab when it was the last.
    const active = section.active === id ? ids[Math.min(index, ids.length - 1)] : section.active
    return withSection(layout, at, { ids, active })
  }
  const columns = layout.columns
    .map((sections, column) => (column === at.column ? sections.filter((_, row) => row !== at.row) : sections))
    .filter((sections) => sections.length > 0)
  return columns.length === 0 ? NO_PANELS : { columns }
}

/** Removes `id`; a section left empty closes, and so does a column left empty. */
export function closePanelTab(layout: PanelLayout, id: string): PanelLayout {
  const at = locate(layout, id)
  return at ? keepFocus(layout, removeTab(layout, at, id)) : layout
}

/** The tab showing `from` shows `to` instead, keeping its place, whether it
 *  is active and whether it is focused. When `to` is already open in another
 *  tab, that tab moves into `from`'s place: an id is open at most once, and the
 *  pane navigating keeps showing where it went. */
export function replacePanelTab(layout: PanelLayout, from: string, to: string): PanelLayout {
  if (from === to) return layout
  if (!locate(layout, from)) return openPanelTab(layout, to)
  const elsewhere = locate(layout, to)
  const rest = elsewhere ? removeTab(layout, elsewhere, to) : layout
  const at = locate(rest, from)!
  const section = sectionAt(rest, at)
  const replaced = withSection(rest, at, {
    ids: section.ids.map((id) => (id === from ? to : id)),
    active: section.active === from ? to : section.active,
  })
  return keepFocus(layout, replaced, layout.focused === from ? to : layout.focused)
}

/** Moves `id` out of its section into a new one to its right or below it. A
 *  section's only tab has nothing to split from and stays put. */
export function splitPanelTab(layout: PanelLayout, id: string, direction: SplitDirection): PanelLayout {
  const at = locate(layout, id)
  if (!at || sectionAt(layout, at).ids.length < 2) return layout
  const rest = removeTab(layout, at, id)
  const section: PanelSection = { ids: [id], active: id }
  if (direction === "right") return insertColumn(rest, at.column + 1, section)
  return {
    columns: rest.columns.map((sections, column) =>
      column === at.column ? [...sections.slice(0, at.row + 1), section, ...sections.slice(at.row + 1)] : sections
    ),
  }
}

/**
 * The arrangement as it fits on screen. `stacked` (a phone) shows every tab in
 * one section; otherwise columns past `maxColumns` fold into the last column
 * that fits, as one section. The URL keeps the full arrangement, so a wider
 * window or another device lays it out again. A folded section shows `current`
 * when it is on show in its own section, else the last folded section's.
 */
export function fitPanelLayout(
  layout: PanelLayout,
  maxColumns: number,
  stacked: boolean,
  current: string | null
): PanelLayout {
  if (!stacked && layout.columns.length <= maxColumns) return layout
  const keep = stacked ? 0 : Math.max(1, maxColumns) - 1
  const folding = layout.columns.slice(keep).flat()
  if (folding.length < 2) return layout
  const ids = folding.flatMap((section) => section.ids)
  const shown = folding.find((section) => section.active === current) ?? folding[folding.length - 1]
  return { columns: [...layout.columns.slice(0, keep), [{ ids, active: shown.active }]] }
}

/**
 * Which pane is current after the arrangement changes from `prev` to `next`: a
 * tab just opened, else wherever {@link followPanel} takes `current`. Null is the
 * main view, and stays null unless a tab opened. A tab swapped for another in
 * place (a draft promoted to its thread) is not an opening.
 */
export function followCurrentPanel(prev: PanelLayout, next: PanelLayout, current: string | null): string | null {
  const before = new Set(panelIdsOf(prev))
  const after = panelIdsOf(next)
  if (after.length > before.size) {
    const opened = after.filter((id) => !before.has(id))
    return opened.find((id) => isPanelOnShow(next, id)) ?? opened[opened.length - 1]
  }
  return followPanel(prev, next, current)
}

/**
 * Where the pane showing `id` is after the arrangement changes from `prev` to
 * `next`: `id` while it stays on show, the tab it was swapped for, else whatever
 * took its place in its section, else the section before its own.
 */
export function followPanel(prev: PanelLayout, next: PanelLayout, id: string | null): string | null {
  if (id === null || isPanelOnShow(next, id)) return id
  const at = locate(prev, id)
  if (!at) return newestPanelOf(next)
  const before = new Set(panelIdsOf(prev))
  const opened = panelIdsOf(next).filter((other) => !before.has(other))
  if (opened.length === 1 && !locate(next, id)) return opened[0]
  for (const other of sectionAt(prev, at).ids) {
    const now = locate(next, other)
    if (now) return sectionAt(next, now).active
  }
  const sections = next.columns.flat()
  if (sections.length === 0) return null
  const index = prev.columns.slice(0, at.column).flat().length + at.row
  return sections[Math.max(0, Math.min(index, sections.length) - 1)].active
}

/** Whether `id` is the tab its section shows. */
export function isPanelOnShow(layout: PanelLayout, id: string): boolean {
  const at = locate(layout, id)
  return at !== null && sectionAt(layout, at).active === id
}
