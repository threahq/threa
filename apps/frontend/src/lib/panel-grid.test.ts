import { describe, it, expect } from "vitest"
import { compilePanelGrid, defaultPanelGridSizes, panelColumnWidths, panelGridShape, resplit } from "./panel-grid"
import { parsePanelLayout } from "./panel-tabs"

describe("compilePanelGrid", () => {
  it("should fill one cell when there is one section", () => {
    expect(compilePanelGrid({ columns: [1], rows: [[1]] })).toEqual({
      rows: "minmax(0,1fr)",
      areas: [["1 / 1 / 2 / 2"]],
    })
  })

  it("should place the columns after the ones the page keeps when it keeps some", () => {
    expect(compilePanelGrid(defaultPanelGridSizes(parsePanelLayout("a-b")), 1)).toEqual({
      rows: "minmax(0,1fr)",
      areas: [["1 / 2 / 2 / 3"], ["1 / 3 / 2 / 4"]],
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
  it("should give the column being read the larger share when a panel opened beside it", () => {
    expect(panelColumnWidths(defaultPanelGridSizes(parsePanelLayout("a-b")).columns, 960)).toEqual([560, 400])
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
