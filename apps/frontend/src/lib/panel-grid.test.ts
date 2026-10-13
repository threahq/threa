import { describe, it, expect } from "vitest"
import {
  compilePanelGrid,
  defaultPanelGridSizes,
  droppedPanelSizes,
  evenPanelColumns,
  evenShares,
  panelColumnWidths,
  panelGridShape,
  resplit,
} from "./panel-grid"
import { dropPanelTab, parsePanelLayout, type PaneEdge } from "./panel-tabs"

describe("compilePanelGrid", () => {
  it("should fill one cell when there is one section", () => {
    expect(compilePanelGrid({ columns: [1], rows: [[1]] })).toEqual({
      rows: "minmax(0,1fr)",
      areas: [["1 / 1 / 2 / 2"]],
    })
  })

  it("should place each column in its own track when there are several", () => {
    expect(compilePanelGrid(defaultPanelGridSizes(parsePanelLayout("a-b")))).toEqual({
      rows: "minmax(0,1fr)",
      areas: [["1 / 1 / 2 / 2"], ["1 / 2 / 2 / 3"]],
    })
  })

  it("should cut rows at every column's section edges when columns stack differently", () => {
    expect(
      compilePanelGrid({
        columns: [1, 1],
        rows: [
          [1, 1],
          [1, 3],
        ],
      })
    ).toEqual({
      rows: "minmax(0,0.25fr) minmax(0,0.25fr) minmax(0,0.5fr)",
      areas: [
        ["1 / 1 / 3 / 2", "3 / 1 / 4 / 2"],
        ["1 / 2 / 2 / 3", "2 / 2 / 4 / 3"],
      ],
    })
  })

  it("should share a row line when two columns cut at the same height", () => {
    expect(
      compilePanelGrid({
        columns: [1, 1],
        rows: [
          [1, 1],
          [2, 2],
        ],
      }).rows
    ).toBe("minmax(0,0.5fr) minmax(0,0.5fr)")
  })
})

describe("panelColumnWidths", () => {
  it("should give the column being read the larger share when a panel opened beside another panel", () => {
    expect(panelColumnWidths(defaultPanelGridSizes(parsePanelLayout("m-a-b")).columns.slice(1), 960)).toEqual([
      560, 400,
    ])
  })
})

describe("panelGridShape", () => {
  it("should count the sections down each column", () => {
    expect(panelGridShape(parsePanelLayout("a.b--c-d"))).toBe("2,1")
  })
})

describe("resplit", () => {
  it("should move the divider between two sections and leave the others alone", () => {
    expect(resplit([1, 1, 2], 0, 1.5)).toEqual([1.5, 0.5, 2])
  })
})

describe("evenShares", () => {
  it("should give every section the same share and keep their total", () => {
    expect(evenShares([1, 1.4, 0.6])).toEqual([1, 1, 1])
  })
})

describe("evenPanelColumns", () => {
  it("should even the panel columns and leave the page's own column and the rows alone", () => {
    expect(evenPanelColumns({ columns: [2, 1, 3], rows: [[1], [1, 2], [1]] })).toEqual({
      columns: [2, 2, 2],
      rows: [[1], [1, 2], [1]],
    })
  })
})

describe("droppedPanelSizes", () => {
  const drop = (layout: string, widths: number[], rows: number[][], id: string, of: string, side: PaneEdge) => {
    const before = parsePanelLayout(layout)
    return droppedPanelSizes(before, widths, rows, dropPanelTab(before, id, { kind: "edge", of, side }), id, side)
  }

  it("should give a pane dropped beside the page alone the half of it its zone showed", () => {
    expect(drop("m", [1000], [[1]], "x", "m", "right")).toEqual({ columns: [500, 500], rows: [[1], [1]] })
  })

  it("should halve the panel a pane is dropped beside and keep every other column's width", () => {
    expect(drop("m-a-b", [400, 350, 250], [[1], [1], [1]], "x", "a", "right")).toEqual({
      columns: [400, 175, 175, 250],
      rows: [[1], [1], [1], [1]],
    })
  })

  it("should let a tab moved out of its own column take half of the one it lands beside", () => {
    expect(drop("m-a-b", [400, 350, 250], [[1], [1], [1]], "b", "a", "left")).toEqual({
      columns: [400, 175, 175],
      rows: [[1], [1], [1]],
    })
  })

  it("should halve the section a pane is dropped under and keep the rest of its column", () => {
    expect(drop("m-a--c", [500, 500], [[1], [2, 1]], "x", "a", "bottom")).toEqual({
      columns: [500, 500],
      rows: [[1], [1, 1, 1]],
    })
  })
})
