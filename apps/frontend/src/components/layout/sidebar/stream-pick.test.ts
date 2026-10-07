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

function pick(panel: string | null, current: string | null, streamId: string) {
  const next = pickStream({ mainStreamId: "stream_a", layout: parsePanelLayout(panel), current }, streamId, parentOf)
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

  it("should keep panes whose stream it can't place, even when their parents loop", () => {
    expect(pick("stream_x-stream_unknown", null, "stream_c")).toEqual({
      mainStreamId: "stream_c",
      panel: "stream_x-stream_unknown",
      current: null,
    })
  })
})

describe("streamOfPane", () => {
  it("should name the stream a row stands for, and none for a pane no row lists", () => {
    expect(
      ["stream_t1", "compose:stream_a", "context:stream_a:files", "draft:stream_a:msg_1", "conv:conv_1"].map(
        streamOfPane
      )
    ).toEqual(["stream_t1", "stream_a", "stream_a", null, null])
  })
})
