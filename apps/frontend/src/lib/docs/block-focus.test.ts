import { afterEach, describe, it, expect, vi } from "vitest"
import { BLOCK_FOCUS_TTL_MS, requestBlockFocus, subscribeBlockFocus, takeBlockFocus } from "./block-focus"

afterEach(() => {
  vi.useRealTimers()
})

describe("block focus", () => {
  it("should hand the requested block over once when the doc takes it", () => {
    requestBlockFocus("stream_plan", "blk_intro")

    expect([takeBlockFocus("stream_plan"), takeBlockFocus("stream_plan")]).toEqual(["blk_intro", null])
  })

  it("should keep the latest request per doc when several docs are requested", () => {
    requestBlockFocus("stream_plan", "blk_intro")
    requestBlockFocus("stream_notes", "blk_summary")
    requestBlockFocus("stream_plan", "blk_outro")

    expect([takeBlockFocus("stream_plan"), takeBlockFocus("stream_notes")]).toEqual(["blk_outro", "blk_summary"])
  })

  it("should return null when nothing was requested for the doc", () => {
    expect(takeBlockFocus("stream_unknown")).toBeNull()
  })

  it("should ignore a request older than the focus lifetime when the doc opens late", () => {
    vi.useFakeTimers()
    requestBlockFocus("stream_plan", "blk_intro")
    requestBlockFocus("stream_notes", "blk_summary")

    vi.advanceTimersByTime(BLOCK_FOCUS_TTL_MS)
    const atLifetime = takeBlockFocus("stream_notes")
    vi.advanceTimersByTime(1)

    expect({ atLifetime, late: takeBlockFocus("stream_plan") }).toEqual({ atLifetime: "blk_summary", late: null })
  })
})

describe("block focus subscription", () => {
  it("should hand only the subscribed doc's requests to its listener, taking them, until it unsubscribes", () => {
    const heard: string[] = []
    const unsubscribe = subscribeBlockFocus("stream_plan", (blockId) => heard.push(blockId))

    requestBlockFocus("stream_plan", "blk_intro")
    requestBlockFocus("stream_notes", "blk_summary")
    unsubscribe()
    requestBlockFocus("stream_plan", "blk_outro")

    expect({
      heard,
      plan: takeBlockFocus("stream_plan"),
      notes: takeBlockFocus("stream_notes"),
    }).toEqual({ heard: ["blk_intro"], plan: "blk_outro", notes: "blk_summary" })
  })
})
