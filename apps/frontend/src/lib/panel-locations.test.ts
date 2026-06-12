import { describe, expect, it } from "vitest"
import {
  panelIdToMainPath,
  mainPathToPanelId,
  parseViewPanel,
  createViewPanelId,
  isPanelableId,
  panelIdFromHref,
} from "./panel-locations"

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

describe("isPanelableId", () => {
  it("accepts streams, draft threads, and views; rejects local-only drafts", () => {
    expect(isPanelableId("stream_abc")).toBe(true)
    expect(isPanelableId("draft:stream_1:msg_1")).toBe(true)
    expect(isPanelableId("view:saved")).toBe(true)
    expect(isPanelableId("draft_xyz")).toBe(false)
    expect(isPanelableId("draft_dm_user_1")).toBe(false)
  })
})

describe("panelIdFromHref", () => {
  const at = (href: string, panels: string[] = [], pathname = "/w/ws_1/s/stream_main") =>
    panelIdFromHref(href, "ws_1", panels, pathname)

  it("resolves a plain stream link to its stream id", () => {
    expect(at("/w/ws_1/s/stream_x")).toBe("stream_x")
  })

  it("resolves view links including sub-views", () => {
    expect(at("/w/ws_1/saved/done")).toBe("view:saved:done")
  })

  it("prefers a panel param the current URL doesn't already have", () => {
    // getPanelUrl-built links keep current panels and name the new target.
    expect(at("/w/ws_1/s/stream_main?panel=a&panel=stream_t", ["a"])).toBe("stream_t")
  })

  it("resolves draft-thread panel params", () => {
    expect(at("/w/ws_1/s/stream_main?panel=draft:stream_main:msg_1")).toBe("draft:stream_main:msg_1")
  })

  it("returns null for a link that goes nowhere new", () => {
    expect(at("/w/ws_1/s/stream_main?panel=a", ["a"])).toBeNull()
  })

  it("returns null for other workspaces, external urls, and non-panel pages", () => {
    expect(at("/w/ws_2/s/stream_x")).toBeNull()
    expect(at("https://example.com/w/ws_1/s/stream_x")).toBeNull()
    expect(at("/w/ws_1/settings")).toBeNull()
  })

  it("returns null for local-only draft streams (no panel surface)", () => {
    expect(at("/w/ws_1/s/draft_xyz")).toBeNull()
  })
})
