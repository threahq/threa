import type { PanelLayout } from "./panel-tabs"

/** How a panel opened beside another panel splits with it: the one being read keeps the larger share. */
export const BESIDE_SPLIT_RATIO = 1.4

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

/** `shares` with the one at `index` set to `leading`, taken from or given to the one after it. */
export function resplit(shares: readonly number[], index: number, leading: number): number[] {
  const pair = shares[index] + shares[index + 1]
  return shares.map((share, at) => {
    if (at === index) return leading
    if (at === index + 1) return pair - leading
    return share
  })
}

const track = (share: number) => `minmax(0,${Number(share.toFixed(4))}fr)`
const sum = (shares: readonly number[]) => shares.reduce((total, share) => total + share, 0)

/** Each column's width when the columns share `width` pixels by their shares. */
export function panelColumnWidths(shares: readonly number[], width: number): number[] {
  const total = sum(shares)
  return shares.map((share) => (width * share) / total)
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
