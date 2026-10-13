import { describe, it, expect } from "vitest"
import {
  carriedPanelSizes,
  compilePanelGrid,
  defaultPanelGridSizes,
  droppedPanelSizes,
  evenPanelColumns,
  evenShares,
  panelColumnWidths,
  panelGridShape,
  resplit,
  sectionSizes,
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

describe("sectionSizes", () => {
  it("should hold a section at the minimum when a smaller window would squeeze it past it", () => {
    expect(sectionSizes([240, 680], 600, 240)).toEqual([240, 360])
  })

  it("should share what the held sections leave by the shares of the rest", () => {
    expect(sectionSizes([1, 6, 6], 900, 240)).toEqual([240, 330, 330])
  })

  it("should hold a section that holding another squeezes in turn", () => {
    expect(sectionSizes([1, 6, 3], 900, 240)).toEqual([240, 420, 240])
  })

  it("should share the room evenly when it is too small for every section's minimum", () => {
    expect(sectionSizes([1, 3], 300, 240)).toEqual([150, 150])
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

describe("carriedPanelSizes", () => {
  const carry = (before: string, sizes: { columns: number[]; rows: number[][] }, after: string) =>
    carriedPanelSizes(parsePanelLayout(before), sizes, parsePanelLayout(after))

  it("should keep a column's width when a section in it closes", () => {
    expect(carry("m-a--b-c", { columns: [1, 0.5, 2], rows: [[1], [1, 3], [1]] }, "m-a-c")).toEqual({
      columns: [1, 0.5, 2],
      rows: [[1], [1], [1]],
    })
  })

  it("should keep the heights of the sections that stay when one between them closes", () => {
    expect(carry("m-a--b--c", { columns: [1, 2], rows: [[1], [1, 2, 3]] }, "m-a--c")).toEqual({
      columns: [1, 2],
      rows: [[1], [1, 3]],
    })
  })

  it("should give a section opened in a column the mean of the shares already there", () => {
    expect(carry("m-a--b-c", { columns: [1, 0.5, 2], rows: [[1], [1, 3], [1]] }, "m-a--b--d-c")).toEqual({
      columns: [1, 0.5, 2],
      rows: [[1], [1, 3, 2], [1]],
    })
  })

  it("should share a section's height between the sections it splits into", () => {
    expect(carry("m-a--b.c", { columns: [1, 2], rows: [[1], [1, 3]] }, "m-a--b--c")).toEqual({
      columns: [1, 2],
      rows: [[1], [1, 1.5, 1.5]],
    })
  })

  it("should give a section the heights of the sections that joined in it", () => {
    expect(carry("m-a--b--c", { columns: [1, 2], rows: [[1], [1, 2, 3]] }, "m-a.b--c")).toEqual({
      columns: [1, 2],
      rows: [[1], [3, 3]],
    })
  })

  it("should keep both sections' heights when a tab moves from one to the one under it", () => {
    expect(carry("m-b.c--a", { columns: [1, 2], rows: [[1], [1, 3]] }, "m-b--a.c")).toEqual({
      columns: [1, 2],
      rows: [[1], [1, 3]],
    })
  })

  it("should carry nothing when a column opens or closes", () => {
    expect(carry("m-a-c", { columns: [1, 0.5, 2], rows: [[1], [1], [1]] }, "m-a")).toBeNull()
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

  it("should let a tab moved out of its own column keep its width, and the one it lands beside keep its own", () => {
    expect(drop("m-a-b", [400, 350, 250], [[1], [1], [1]], "b", "a", "left")).toEqual({
      columns: [400, 250, 350],
      rows: [[1], [1], [1]],
    })
  })

  it("should let a tab moved out of its own column keep its width on a right edge too", () => {
    expect(drop("m-a-b-c", [400, 350, 250, 200], [[1], [1], [1], [1]], "c", "a", "right")).toEqual({
      columns: [400, 350, 200, 250],
      rows: [[1], [1], [1], [1]],
    })
  })

  it("should give the page's own pane half of the one it lands beside, as its column is what the panels leave", () => {
    expect(drop("m-a-b", [400, 350, 250], [[1], [1], [1]], "m", "b", "right")).toEqual({
      columns: [350, 125, 125],
      rows: [[1], [1], [1]],
    })
  })

  it("should give a tab moved out of a shared section half of the one it lands beside", () => {
    expect(drop("m-a-b.c", [400, 350, 250], [[1], [1], [1]], "c", "a", "left")).toEqual({
      columns: [400, 175, 175, 250],
      rows: [[1], [1], [1], [1]],
    })
  })

  it("should give a tab moved out of a column of several rows half of the one it lands beside", () => {
    expect(drop("m-a-b--c", [400, 350, 250], [[1], [1], [1, 1]], "c", "a", "left")).toEqual({
      columns: [400, 175, 175, 250],
      rows: [[1], [1], [1], [1]],
    })
  })

  it("should halve the section a pane is dropped under and keep the rest of its column", () => {
    expect(drop("m-a--c", [500, 500], [[1], [2, 1]], "x", "a", "bottom")).toEqual({
      columns: [500, 500],
      rows: [[1], [1, 1, 1]],
    })
  })
})
