import { locate, type PaneEdge, type PanelLayout, type PanelSection } from "./panel-tabs"

/** How a panel opened beside another panel splits with it: the one being read keeps the larger share. */
export const BESIDE_SPLIT_RATIO = 1.4

// Room for a tab row's tab on show and "+N" beside the menu, focus and close.
export const MIN_SECTION_WIDTH = 240
export const MIN_SECTION_HEIGHT = 120

/** Relative sizes of the columns, and of the sections down each column. */
export interface PanelGridSizes {
  columns: readonly number[]
  rows: readonly (readonly number[])[]
}

interface PanelGrid {
  rows: string
  /** `grid-area` of each section, by column then row. */
  areas: string[][]
}

/** Sections per column: sizes are kept per shape, so a split and its undo find their sizes again. */
export function panelGridShape(layout: PanelLayout): string {
  return layout.columns.map((column) => column.length).join(",")
}

export function defaultPanelGridSizes(layout: PanelLayout): PanelGridSizes {
  const count = layout.columns.length
  return {
    columns: layout.columns.map((_, index) => (index === 1 && count > 2 ? BESIDE_SPLIT_RATIO : 1)),
    rows: layout.columns.map((column) => column.map(() => 1)),
  }
}

/** `shares` made equal, keeping their total. */
export function evenShares(shares: readonly number[]): number[] {
  const share = sum(shares) / shares.length
  return shares.map(() => share)
}

/** `sizes` with the panel columns, all but the page's own first one, made equal. */
export function evenPanelColumns(sizes: PanelGridSizes): PanelGridSizes {
  return { ...sizes, columns: [sizes.columns[0], ...evenShares(sizes.columns.slice(1))] }
}

/** `shares` with the one at `index` set to `leading`, taken from or given to the one after it. */
export function resplit(shares: readonly number[], index: number, leading: number): number[] {
  const pair = shares[index] + shares[index + 1]
  return shares.map((share, at) => {
    if (at === index) return leading
    if (at === index + 1) return pair - leading
    return share
  })
}

/**
 * `sizes`, held for `before`, as `after` holds them: every column keeps its
 * share, a section on show in both keeps its own, one that sections joined in
 * takes all of theirs, the sections one split into share its own, and one
 * `after` adds takes the mean of its column's. Null where the two differ in
 * columns, whose widths are then shared anew.
 */
export function carriedPanelSizes(
  before: PanelLayout,
  sizes: PanelGridSizes,
  after: PanelLayout
): PanelGridSizes | null {
  if (before.columns.length !== after.columns.length) return null
  return {
    columns: sizes.columns,
    rows: after.columns.map((sections, column) => {
      const shares = sizes.rows[column]
      const heirs = before.columns[column].map((held) =>
        sections.filter((section) => held.ids.some((id) => section.ids.includes(id)))
      )
      // A section's own are the ones that went to it alone; a tab another lent it is no claim on that one's share.
      const own = sections.map((section) =>
        sum(shares.filter((_, row) => heirs[row].length === 1 && heirs[row][0] === section))
      )
      const split = sections.map((section, at) => (own[at] > 0 ? -1 : heirs.findIndex((to) => to.includes(section))))
      const kept = sections.map((_, at) => {
        if (own[at] > 0) return own[at]
        return split[at] === -1 ? null : shares[split[at]] / split.filter((row) => row === split[at]).length
      })
      const held = kept.filter((share) => share !== null)
      const added = held.length > 0 ? sum(held) / held.length : 1
      return kept.map((share) => share ?? added)
    }),
  }
}

const track = (share: number) => `minmax(0,${Number(share.toFixed(4))}fr)`
const sum = (shares: readonly number[]) => shares.reduce((total, share) => total + share, 0)

/**
 * Each section's pixels when the sections share `total` by their shares, none under `min`: one a smaller
 * window would squeeze past it keeps it, and the rest share what is left. Too many for `total` share it evenly.
 */
export function sectionSizes(shares: readonly number[], total: number, min: number): number[] {
  const floor = Math.min(min, total / shares.length)
  let roomy = shares.map((_, index) => index)
  for (;;) {
    const unit = (total - floor * (shares.length - roomy.length)) / sum(roomy.map((index) => shares[index]))
    const squeezed = roomy.filter((index) => shares[index] * unit < floor)
    if (squeezed.length === 0) return shares.map((share, index) => (roomy.includes(index) ? share * unit : floor))
    roomy = roomy.filter((index) => !squeezed.includes(index))
  }
}

/** Each column's width when the columns share `width` pixels by their shares. */
export function panelColumnWidths(shares: readonly number[], width: number): number[] {
  return sectionSizes(shares, width, MIN_SECTION_WIDTH)
}
/**
 * The width the tab `id` brings to a side-edge drop: its column's, from
 * `widths`, where it holds that column alone; else none. The page's own column
 * is what the panels leave, not a width to bring.
 */
export function broughtWidth(layout: PanelLayout, id: string | null, widths: readonly number[]): number | null {
  const at = id === null ? null : locate(layout, id)
  if (at === null || at.column === 0) return null
  const column = layout.columns[at.column]
  return column.length === 1 && column[0].ids.length === 1 ? (widths[at.column] ?? null) : null
}

/**
 * Sizes for `after`, the arrangement a drop of `id` on the `side` edge of a pane
 * of `before` made: the dropped pane takes the half of that pane its zone showed,
 * the pane keeps the other half, and every other column and section keeps its
 * size. A pane that held a column of its own brings that column's width along
 * instead, and the pane it lands beside keeps all of its own. `widths` are
 * `before`'s columns in pixels, the page's own first; the result's columns are
 * pixels too.
 */
export function droppedPanelSizes(
  before: PanelLayout,
  widths: readonly number[],
  rows: readonly (readonly number[])[],
  after: PanelLayout,
  id: string,
  side: PaneEdge
): PanelGridSizes {
  const origin = (section: PanelSection) => {
    const other = section.ids.find((tab) => tab !== id)
    return other === undefined ? null : locate(before, other)
  }
  const shareOf = (section: PanelSection) => {
    const from = origin(section)
    return from ? rows[from.column][from.row] : 0
  }
  const widthOf = (column: number) => widths[after.columns[column].map(origin).find((from) => from !== null)!.column]
  const step = side === "right" || side === "bottom" ? -1 : 1

  if (side === "left" || side === "right") {
    const added = after.columns.findIndex((sections) => sections.every((section) => origin(section) === null))
    const beside = added + step
    const brought = broughtWidth(before, id, widths)
    const widthAt = (column: number) => {
      if (column === added) return brought ?? widthOf(beside) / 2
      if (column === beside) return brought === null ? widthOf(beside) / 2 : widthOf(beside)
      return widthOf(column)
    }
    return {
      columns: after.columns.map((_, column) => widthAt(column)),
      rows: after.columns.map((sections, column) => (column === added ? [1] : sections.map(shareOf))),
    }
  }
  return {
    columns: after.columns.map((_, column) => widthOf(column)),
    rows: after.columns.map((sections) => {
      const added = sections.findIndex((section) => origin(section) === null)
      if (added === -1) return sections.map(shareOf)
      const half = shareOf(sections[added + step]) / 2
      return sections.map((section, row) => (row === added || row === added + step ? half : shareOf(section)))
    }),
  }
}

const edgeKey = (edge: number) => edge.toFixed(4)

/**
 * Compiles the arrangement to the page's grid, so every tab can be a flat child
 * of the same parent wherever its section sits. Columns stack their sections
 * independently, so the row tracks are cut at every column's section edges and
 * each section spans the tracks between its own.
 */
export function compilePanelGrid(sizes: PanelGridSizes): PanelGrid {
  const edges = sizes.rows.map((rows) => {
    const total = sum(rows)
    let reached = 0
    return [0, ...rows.map((share) => (reached += share) / total)]
  })
  const cuts = [...new Map(edges.flat().map((edge) => [edgeKey(edge), edge])).values()].sort((a, b) => a - b)
  const line = new Map(cuts.map((cut, index) => [edgeKey(cut), index + 1]))
  return {
    rows: cuts
      .slice(1)
      .map((cut, index) => track(cut - cuts[index]))
      .join(" "),
    areas: edges.map((columnEdges, column) =>
      columnEdges
        .slice(1)
        .map(
          (end, row) =>
            `${line.get(edgeKey(columnEdges[row]))} / ${column + 1} / ${line.get(edgeKey(end))} / ${column + 2}`
        )
    ),
  }
}
