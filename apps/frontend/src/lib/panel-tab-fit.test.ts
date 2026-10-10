import { describe, expect, it } from "vitest"
import { fitPanelTabs, MIN_TAB_WIDTH, MORE_TABS_WIDTH, splitVisibleTabs, tabRowReserve } from "./panel-tab-fit"

describe("fitPanelTabs", () => {
  const active = 180
  const three = active + 2 * MIN_TAB_WIDTH

  it("should show every tab and the labels when they all fit", () => {
    expect(fitPanelTabs(three + 60, 3, active, 60)).toEqual({ labels: true, visible: 3 })
  })

  it("should fold the labels before any tab", () => {
    expect(fitPanelTabs(three + 59, 3, active, 60)).toEqual({ labels: false, visible: 3 })
    expect(fitPanelTabs(three, 3, active, 60)).toEqual({ labels: false, visible: 3 })
  })

  it("should shrink the tab on show to keep every tab before folding any", () => {
    expect(fitPanelTabs(3 * MIN_TAB_WIDTH, 3, active, 60)).toEqual({ labels: false, visible: 3 })
  })

  it("should fold as many trailing tabs as the room needs once every tab is at its minimum", () => {
    expect(fitPanelTabs(3 * MIN_TAB_WIDTH - 1, 3, active, 60)).toEqual({ labels: false, visible: 2 })
    expect(fitPanelTabs(3 * MIN_TAB_WIDTH + MORE_TABS_WIDTH, 6, active, 60)).toEqual({ labels: false, visible: 3 })
    expect(fitPanelTabs(3 * MIN_TAB_WIDTH + MORE_TABS_WIDTH - 1, 6, active, 60)).toEqual({ labels: false, visible: 2 })
  })

  it("should show as many tabs whichever tab is on show", () => {
    const room = 355
    const widths = [60, 120, 224].map((width) => fitPanelTabs(room, 6, width, 60).visible)
    expect(widths).toEqual([3, 3, 3])
  })

  it("should keep the tab on show however narrow the row gets", () => {
    expect(fitPanelTabs(40, 5, active, 60)).toEqual({ labels: false, visible: 1 })
  })

  it("should fold the second of two tabs only when both can't have the minimum", () => {
    expect(fitPanelTabs(2 * MIN_TAB_WIDTH, 2, active, 0)).toEqual({ labels: false, visible: 2 })
    expect(fitPanelTabs(2 * MIN_TAB_WIDTH - 1, 2, active, 0)).toEqual({ labels: false, visible: 1 })
  })
})

describe("splitVisibleTabs", () => {
  const ids = ["a", "b", "c", "d"]

  it("should fold the trailing tabs", () => {
    expect(splitVisibleTabs(ids, "a", 2)).toEqual({ shown: ["a", "b"], folded: ["c", "d"] })
  })

  it("should swap the tab on show into the last visible slot when it would fold", () => {
    expect(splitVisibleTabs(ids, "d", 2)).toEqual({ shown: ["a", "d"], folded: ["b", "c"] })
  })

  it("should show every tab when they all fit", () => {
    expect(splitVisibleTabs(ids, "c", 4)).toEqual({ shown: ids, folded: [] })
  })
})

describe("tabRowReserve", () => {
  it("should leave a row of more than two tabs room to show two of them beside +N", () => {
    for (const tabs of [2, 3, 6]) {
      expect(fitPanelTabs(tabRowReserve(tabs), tabs, 2 * MIN_TAB_WIDTH, 60).visible).toBe(2)
    }
  })
})
