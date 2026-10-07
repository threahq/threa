import { describe, expect, it } from "vitest"
import { formatPanelLayout, parsePanelLayout } from "@/lib/panel-tabs"
import { pickStream, streamOfPane } from "./stream-pick"

const parents: Record<string, string> = {
  stream_t1: "stream_a",
  stream_t2: "stream_t1",
  stream_x: "stream_y",
  stream_y: "stream_x",
}
const parentOf = (id: string) => parents[id] ?? null

function pick(panel: string | null, current: string | null, streamId: string, stacked = false) {
  const page = { mainStreamId: "stream_a", layout: parsePanelLayout(panel), current, stacked }
  const next = pickStream(page, streamId, parentOf)
  return { mainStreamId: next.mainStreamId, panel: formatPanelLayout(next.layout), current: next.current }
}

describe("pickStream", () => {
  it("should swap the tab worked in for the picked stream and close what was opened from it when a tab is current", () => {
    expect(pick("stream_t1*.stream_b-stream_t2-compose:stream_t1", "stream_t1", "stream_c")).toEqual({
      mainStreamId: "stream_a",
      panel: "stream_c*.stream_b",
      current: "stream_c",
    })
  })

  it("should move main to the picked stream and close only main's own panes when main is current", () => {
    expect(pick("stream_t1-context:stream_a-draft:stream_a:msg_1-stream_b", null, "stream_c")).toEqual({
      mainStreamId: "stream_c",
      panel: "stream_b",
      current: null,
    })
  })

  it("should bring an open stream forward instead of opening it twice", () => {
    expect(pick("stream_t1*.stream_b", null, "stream_b")).toEqual({
      mainStreamId: "stream_a",
      panel: "stream_t1.stream_b",
      current: "stream_b",
    })
  })

  it("should return to main without closing anything when main's own stream is picked from a tab", () => {
    expect(pick("stream_t1-stream_b", "stream_b", "stream_a")).toEqual({
      mainStreamId: "stream_a",
      panel: "stream_t1-stream_b",
      current: null,
    })
  })

  it("should replace the stream an overview or a new thread's draft belongs to, not the pane itself", () => {
    expect([
      pick("stream_b-context:stream_b-stream_t1", "context:stream_b", "stream_c"),
      pick("stream_t1-draft:stream_t1:msg_1", "draft:stream_t1:msg_1", "stream_c"),
      pick("stream_b-context:stream_a", "context:stream_a", "stream_c"),
    ]).toEqual([
      { mainStreamId: "stream_a", panel: "stream_c-stream_t1", current: "stream_c" },
      { mainStreamId: "stream_a", panel: "stream_c", current: "stream_c" },
      { mainStreamId: "stream_c", panel: "stream_b", current: null },
    ])
  })

  it("should keep a floating tab floating when it is replaced, and let it sink when main's stream is picked", () => {
    expect([
      pick("stream_t1**.stream_b", "stream_t1", "stream_c"),
      pick("stream_t1**", "stream_t1", "stream_a"),
    ]).toEqual([
      { mainStreamId: "stream_a", panel: "stream_c**.stream_b", current: "stream_c" },
      { mainStreamId: "stream_a", panel: "stream_t1", current: null },
    ])
  })

  it("should close every tab over the main view when a pick lands there on a phone", () => {
    expect([
      pick("stream_b", "stream_b", "stream_a", true),
      pick("stream_b-context:stream_a", "context:stream_a", "stream_c", true),
      pick("stream_b-stream_t1", "stream_t1", "stream_c", true),
    ]).toEqual([
      { mainStreamId: "stream_a", panel: null, current: null },
      { mainStreamId: "stream_c", panel: null, current: null },
      { mainStreamId: "stream_a", panel: "stream_b-stream_c", current: "stream_c" },
    ])
  })

  it("should keep panes whose stream it can't place, even when their parents loop", () => {
    expect(pick("stream_x-stream_unknown", null, "stream_c")).toEqual({
      mainStreamId: "stream_c",
      panel: "stream_x-stream_unknown",
      current: null,
    })
  })
})

describe("streamOfPane", () => {
  it("should name the stream a pane belongs to, and none for a conversation", () => {
    expect(
      ["stream_t1", "compose:stream_a", "context:stream_a:files", "draft:stream_a:msg_1", "conv:conv_1"].map(
        streamOfPane
      )
    ).toEqual(["stream_t1", "stream_a", "stream_a", "stream_a", null])
  })
})
