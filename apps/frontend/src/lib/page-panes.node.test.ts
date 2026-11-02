import { describe, it, expect } from "vitest"
import { isPinnedPagePane, pagePaneAt, pagePathOf, pagePatternOf, pageTitleOf } from "./page-panes"

describe("pagePaneAt", () => {
  it("should name the pane of a workspace page, its params and trailing slash included", () => {
    expect([
      pagePaneAt("/w/ws/activity"),
      pagePaneAt("/w/ws/activity/unread/"),
      pagePaneAt("/w/ws/labels/label_1"),
    ]).toEqual(["page:activity", "page:activity/unread", "page:labels/label_1"])
  })

  it("should name nothing where the path is no page that opens as a pane", () => {
    expect([
      pagePaneAt("/w/ws/s/stream_a"),
      pagePaneAt("/w/ws/settings"),
      pagePaneAt("/w/ws"),
      pagePaneAt("/login"),
    ]).toEqual([null, null, null, null])
  })
})

describe("page pane ids", () => {
  it("should read a page pane's path, route and title", () => {
    expect([pagePathOf("page:saved/done"), pagePatternOf("page:saved/done"), pageTitleOf("page:saved/done")]).toEqual([
      "/saved/done",
      "/saved/:tab?",
      "Saved",
    ])
  })

  it("should read nothing from an id that is no listed page", () => {
    expect([pagePathOf("stream_a"), pagePathOf("page:persona"), pageTitleOf("page:settings")]).toEqual([
      null,
      null,
      null,
    ])
  })

  it("should pin only a page its route alone shows", () => {
    expect([isPinnedPagePane("page:persona"), isPinnedPagePane("page:board"), isPinnedPagePane("stream_a")]).toEqual([
      true,
      false,
      false,
    ])
  })
})
