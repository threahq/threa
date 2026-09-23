import { describe, expect, it } from "vitest"
import { stepSidebarStream } from "./stream-step"

describe("stepSidebarStream", () => {
  const order = ["stream_a", "stream_b", "stream_c"]

  it("should step to the neighbour of the active stream", () => {
    expect([stepSidebarStream(order, "stream_b", 1), stepSidebarStream(order, "stream_b", -1)]).toEqual([
      "stream_c",
      "stream_a",
    ])
  })

  it("should stop at the ends instead of wrapping", () => {
    expect([stepSidebarStream(order, "stream_c", 1), stepSidebarStream(order, "stream_a", -1)]).toEqual([null, null])
  })

  it("should enter from the edge when the active stream is not in the sidebar", () => {
    expect([stepSidebarStream(order, "stream_x", 1), stepSidebarStream(order, undefined, -1)]).toEqual([
      "stream_a",
      "stream_c",
    ])
  })
})
