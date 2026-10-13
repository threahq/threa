import { describe, expect, it } from "vitest"
import { canonicalPanelLayout, formatPanelLayout, fullPanelLayout, parsePanelLayout } from "@/lib/panel-tabs"
import { pickStream, streamOfPane } from "./stream-pick"

const parents: Record<string, string> = {
  stream_t1: "stream_a",
  stream_t2: "stream_t1",
  stream_x: "stream_y",
  stream_y: "stream_x",
}
const parentOf = (id: string) => parents[id] ?? null

/** A pick on `/s/stream_a?panel=<panel>`, read back as the route it lands on. */
function pick(panel: string | null, current: string, streamId: string) {
  const page = { layout: fullPanelLayout("stream_a", parsePanelLayout(panel)), current }
  const next = pickStream(page, streamId, parentOf)
  return { path: next.current, panel: formatPanelLayout(canonicalPanelLayout(next.layout, next.current)) }
}

describe("pickStream", () => {
  it("should swap the pane worked in for the picked stream and close what was opened from it", () => {
    expect(pick("stream_t1*.stream_b-stream_t2-compose:stream_t1", "stream_t1", "stream_c")).toEqual({
      path: "stream_c",
      panel: "stream_a-stream_c*.stream_b",
    })
  })

  it("should swap the route's own stream and close only its own panes when it is current", () => {
    expect(pick("stream_t1-context:stream_a-draft:stream_a:msg_1-stream_b", "stream_a", "stream_c")).toEqual({
      path: "stream_c",
      panel: "stream_b",
    })
  })

  it("should bring an open stream forward instead of opening it twice", () => {
    expect(pick("stream_t1*.stream_b", "stream_a", "stream_b")).toEqual({
      path: "stream_b",
      panel: "stream_a-stream_t1.stream_b",
    })
  })

  it("should return to the route's stream without closing anything when it is picked from another pane", () => {
    expect(pick("stream_t1-stream_b", "stream_b", "stream_a")).toEqual({
      path: "stream_a",
      panel: "stream_t1-stream_b",
    })
  })

  it("should replace the stream an overview or a new thread's draft belongs to, not the pane itself", () => {
    expect([
      pick("stream_b-context:stream_b-stream_t1", "context:stream_b", "stream_c"),
      pick("stream_t1-draft:stream_t1:msg_1", "draft:stream_t1:msg_1", "stream_c"),
      pick("stream_b-context:stream_a", "context:stream_a", "stream_c"),
    ]).toEqual([
      { path: "stream_c", panel: "stream_a-stream_c-stream_t1" },
      { path: "stream_c", panel: "stream_a-stream_c" },
      { path: "stream_c", panel: "stream_b" },
    ])
  })

  it("should keep a floating pane floating when it is replaced, and let it sink when another open stream is picked", () => {
    expect([
      pick("stream_t1**.stream_b", "stream_t1", "stream_c"),
      pick("stream_t1**", "stream_t1", "stream_a"),
    ]).toEqual([
      { path: "stream_c", panel: "stream_a-stream_c**.stream_b" },
      { path: "stream_a", panel: "stream_t1" },
    ])
  })

  it("should keep panes whose stream it can't place, even when their parents loop", () => {
    expect(pick("stream_x-stream_unknown", "stream_a", "stream_c")).toEqual({
      path: "stream_c",
      panel: "stream_x-stream_unknown",
    })
  })
})

describe("streamOfPane", () => {
  it("should name the stream a pane belongs to, and none for a conversation", () => {
    expect(
      [
        "stream_t1",
        "compose:stream_a",
        "convs:stream_a",
        "context:stream_a:files",
        "draft:stream_a:msg_1",
        "conv:conv_1",
      ].map(streamOfPane)
    ).toEqual(["stream_t1", "stream_a", "stream_a", "stream_a", "stream_a", null])
  })
})
