import { describe, expect, it } from "vitest"
import { panelIdToMainPath, mainPathToPanelId, parseViewPanel, createViewPanelId } from "./panel-locations"

describe("parseViewPanel / createViewPanelId", () => {
  it("round-trips view ids with and without sub-views", () => {
    expect(parseViewPanel("view:saved")).toEqual({ view: "saved", subView: null })
    expect(parseViewPanel("view:saved:done")).toEqual({ view: "saved", subView: "done" })
    expect(parseViewPanel("view:unknown")).toBeNull()
    expect(parseViewPanel("stream_1")).toBeNull()
    expect(createViewPanelId("activity", "unread")).toBe("view:activity:unread")
    expect(createViewPanelId("activity", null)).toBe("view:activity")
  })
})

describe("panelIdToMainPath", () => {
  it("maps stream ids to the stream route", () => {
    expect(panelIdToMainPath("ws_1", "stream_abc")).toBe("/w/ws_1/s/stream_abc")
  })

  it("maps view ids to their page routes including sub-views", () => {
    expect(panelIdToMainPath("ws_1", "view:saved")).toBe("/w/ws_1/saved")
    expect(panelIdToMainPath("ws_1", "view:saved:done")).toBe("/w/ws_1/saved/done")
    expect(panelIdToMainPath("ws_1", "view:activity:me")).toBe("/w/ws_1/activity/me")
  })

  it("returns null for drafts and unknown views (no routed equivalent)", () => {
    expect(panelIdToMainPath("ws_1", "draft:stream_1:msg_1")).toBeNull()
    expect(panelIdToMainPath("ws_1", "view:bogus")).toBeNull()
  })
})

describe("mainPathToPanelId", () => {
  it("maps stream and view routes back to panel ids", () => {
    expect(mainPathToPanelId("/w/ws_1/s/stream_abc")).toBe("stream_abc")
    expect(mainPathToPanelId("/w/ws_1/saved")).toBe("view:saved")
    expect(mainPathToPanelId("/w/ws_1/saved/done")).toBe("view:saved:done")
    expect(mainPathToPanelId("/w/ws_1/activity/unread")).toBe("view:activity:unread")
  })

  it("returns null for pages without a panel equivalent", () => {
    expect(mainPathToPanelId("/w/ws_1/memory")).toBeNull()
    expect(mainPathToPanelId("/w/ws_1")).toBeNull()
    expect(mainPathToPanelId("/workspaces")).toBeNull()
  })
})
