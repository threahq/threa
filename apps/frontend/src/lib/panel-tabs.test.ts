import { describe, it, expect } from "vitest"
import {
  NO_PANEL_TABS,
  activatePanelTab,
  closePanelTab,
  formatPanelTabs,
  openPanelTab,
  parsePanelTabs,
  replacePanelTab,
} from "./panel-tabs"

describe("parsePanelTabs", () => {
  it("should read a single panel id as one active tab when the URL predates tabs", () => {
    expect(parsePanelTabs("stream_a")).toEqual({ ids: ["stream_a"], active: "stream_a" })
  })

  it("should make the last tab active when no tab is marked", () => {
    expect(parsePanelTabs("stream_a.stream_b")).toEqual({ ids: ["stream_a", "stream_b"], active: "stream_b" })
  })

  it("should make the marked tab active when one is marked", () => {
    expect(parsePanelTabs("stream_a*.conv:conv_b")).toEqual({ ids: ["stream_a", "conv:conv_b"], active: "stream_a" })
  })

  it("should keep draft ids whole when they carry colons", () => {
    expect(parsePanelTabs("draft:stream_p:msg_1.stream_b")).toEqual({
      ids: ["draft:stream_p:msg_1", "stream_b"],
      active: "stream_b",
    })
  })

  it("should drop empty and repeated ids when the value was hand-edited", () => {
    expect(parsePanelTabs(".stream_a..stream_a*.stream_b.")).toEqual({
      ids: ["stream_a", "stream_b"],
      active: "stream_b",
    })
  })

  it("should read no tabs when the param is missing or empty", () => {
    expect([parsePanelTabs(null), parsePanelTabs(""), parsePanelTabs("*")]).toEqual([
      NO_PANEL_TABS,
      NO_PANEL_TABS,
      NO_PANEL_TABS,
    ])
  })
})

describe("formatPanelTabs", () => {
  it("should write one spelling per arrangement when it round-trips", () => {
    const values = ["stream_a", "stream_a.stream_b", "stream_a*.stream_b", "stream_a.stream_b*.stream_c"]
    expect(values.map((value) => formatPanelTabs(parsePanelTabs(value)))).toEqual(values)
  })

  it("should write nothing when no tab is open", () => {
    expect(formatPanelTabs(NO_PANEL_TABS)).toBeNull()
  })
})

describe("tab operations", () => {
  const tabs = parsePanelTabs("stream_a.stream_b*.stream_c")

  it("should append and activate a tab when it isn't open", () => {
    expect(openPanelTab(tabs, "stream_d")).toEqual({
      ids: ["stream_a", "stream_b", "stream_c", "stream_d"],
      active: "stream_d",
    })
  })

  it("should activate a tab in place when it is already open", () => {
    expect(openPanelTab(tabs, "stream_a")).toEqual({ ids: ["stream_a", "stream_b", "stream_c"], active: "stream_a" })
  })

  it("should leave the tabs alone when activating one that isn't open", () => {
    expect(activatePanelTab(tabs, "stream_z")).toBe(tabs)
  })

  it("should hand focus to the tab that slides into place when the active tab closes", () => {
    expect(closePanelTab(tabs, "stream_b")).toEqual({ ids: ["stream_a", "stream_c"], active: "stream_c" })
  })

  it("should hand focus to the new last tab when the active last tab closes", () => {
    expect(closePanelTab(parsePanelTabs("stream_a.stream_b"), "stream_b")).toEqual({
      ids: ["stream_a"],
      active: "stream_a",
    })
  })

  it("should keep the active tab when another tab closes", () => {
    expect(closePanelTab(tabs, "stream_a")).toEqual({ ids: ["stream_b", "stream_c"], active: "stream_b" })
  })

  it("should leave no tabs when the only one closes", () => {
    expect(closePanelTab(parsePanelTabs("stream_a"), "stream_a")).toEqual(NO_PANEL_TABS)
  })

  it("should swap a tab in place when it navigates somewhere new", () => {
    expect(replacePanelTab(tabs, "stream_b", "stream_x")).toEqual({
      ids: ["stream_a", "stream_x", "stream_c"],
      active: "stream_x",
    })
  })

  it("should keep an inactive tab inactive when it is replaced", () => {
    expect(replacePanelTab(tabs, "stream_a", "stream_x")).toEqual({
      ids: ["stream_x", "stream_b", "stream_c"],
      active: "stream_b",
    })
  })

  it("should close the navigating tab and activate the target when the target is already open", () => {
    expect(replacePanelTab(tabs, "stream_b", "stream_c")).toEqual({ ids: ["stream_a", "stream_c"], active: "stream_c" })
  })

  it("should open the target as a new tab when the navigating tab is already gone", () => {
    expect(replacePanelTab(tabs, "stream_gone", "stream_x")).toEqual(openPanelTab(tabs, "stream_x"))
  })
})
