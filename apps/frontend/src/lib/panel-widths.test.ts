import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { loadPanelWidths, savePanelWidth } from "./panel-widths"

describe("panel-widths", () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => localStorage.clear())

  it("round-trips widths per workspace, keyed by panel id", () => {
    savePanelWidth("ws_1", "stream_a", 520)
    savePanelWidth("ws_1", "view:saved", 360)
    expect(loadPanelWidths("ws_1")).toEqual({ stream_a: 520, "view:saved": 360 })
  })

  it("rounds widths and overwrites a panel's prior width", () => {
    savePanelWidth("ws_1", "stream_a", 400)
    savePanelWidth("ws_1", "stream_a", 612.7)
    expect(loadPanelWidths("ws_1")).toEqual({ stream_a: 613 })
  })

  it("scopes widths by workspace", () => {
    savePanelWidth("ws_1", "stream_a", 500)
    savePanelWidth("ws_2", "stream_a", 300)
    expect(loadPanelWidths("ws_1")).toEqual({ stream_a: 500 })
    expect(loadPanelWidths("ws_2")).toEqual({ stream_a: 300 })
  })

  it("returns an empty map for an unknown workspace", () => {
    expect(loadPanelWidths("ws_none")).toEqual({})
  })

  it("ignores non-positive / non-finite / malformed stored values", () => {
    localStorage.setItem("threa:panel-widths:ws_1", JSON.stringify({ a: 500, b: 0, c: -10, d: "wide", e: null }))
    expect(loadPanelWidths("ws_1")).toEqual({ a: 500 })
  })

  it("returns an empty map on unparseable JSON rather than throwing", () => {
    localStorage.setItem("threa:panel-widths:ws_1", "{not json")
    expect(loadPanelWidths("ws_1")).toEqual({})
  })
})
