import { describe, expect, it } from "vitest"
import { fitPanelTabs, MIN_TAB_WIDTH, MORE_TABS_WIDTH, splitVisibleTabs } from "./panel-tab-fit"

describe("fitPanelTabs", () => {
  const active = 180
  const three = active + 2 * MIN_TAB_WIDTH

  it("should show every tab, the labels and the Focus button when they all fit", () => {
    expect(fitPanelTabs(three + 60 + 32, 3, active, 60, 32)).toEqual({ labels: true, focus: true, visible: 3 })
  })

  it("should fold the labels, then the Focus button, before any tab", () => {
    expect(fitPanelTabs(three + 60 + 31, 3, active, 60, 32)).toEqual({ labels: false, focus: true, visible: 3 })
    expect(fitPanelTabs(three + 32, 3, active, 60, 32)).toEqual({ labels: false, focus: true, visible: 3 })
    expect(fitPanelTabs(three + 31, 3, active, 60, 32)).toEqual({ labels: false, focus: false, visible: 3 })
    expect(fitPanelTabs(three, 3, active, 60, 32)).toEqual({ labels: false, focus: false, visible: 3 })
  })

  it("should fold trailing tabs into the menu once the labels are gone", () => {
    expect(fitPanelTabs(three - 1, 3, active, 60, 32)).toEqual({ labels: false, focus: false, visible: 2 })
    expect(fitPanelTabs(active + MIN_TAB_WIDTH + MORE_TABS_WIDTH, 3, active, 0, 0)).toEqual({
      labels: false,
      focus: false,
      visible: 2,
    })
    expect(fitPanelTabs(active + MIN_TAB_WIDTH + MORE_TABS_WIDTH - 1, 3, active, 0, 0)).toEqual({
      labels: false,
      focus: false,
      visible: 1,
    })
  })

  it("should keep the tab on show however narrow the row gets", () => {
    expect(fitPanelTabs(40, 5, active, 60, 32)).toEqual({ labels: false, focus: false, visible: 1 })
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
