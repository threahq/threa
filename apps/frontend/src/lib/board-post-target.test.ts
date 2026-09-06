import { describe, it, expect } from "vitest"
import { StreamTypes } from "@threahq/types"
import { isPostableStream, targetForValue, NEW_SCRATCHPAD, NEW_QUICK_NOTE } from "./board-post-target"

describe("targetForValue", () => {
  it("maps the empty value to null", () => {
    expect(targetForValue("")).toBeNull()
  })

  it("maps the New-scratchpad sentinel to a companion-on scratchpad target", () => {
    expect(targetForValue(NEW_SCRATCHPAD)).toEqual({ type: "newScratchpad", companionMode: "on" })
  })

  it("maps the New-quick-note sentinel to a companion-off scratchpad target", () => {
    expect(targetForValue(NEW_QUICK_NOTE)).toEqual({ type: "newScratchpad", companionMode: "off" })
  })

  it("maps a stream id to a stream target", () => {
    expect(targetForValue("stream_abc")).toEqual({ type: "stream", streamId: "stream_abc" })
  })
})

describe("isPostableStream", () => {
  it("accepts live channels and DMs", () => {
    expect(isPostableStream({ type: StreamTypes.CHANNEL, archivedAt: null, e2eEnabled: false })).toBe(true)
    expect(isPostableStream({ type: StreamTypes.DM, archivedAt: null, e2eEnabled: false })).toBe(true)
  })

  it("rejects scratchpads, threads, and system streams (not authored-into surfaces)", () => {
    expect(isPostableStream({ type: StreamTypes.SCRATCHPAD, archivedAt: null, e2eEnabled: false })).toBe(false)
    expect(isPostableStream({ type: StreamTypes.THREAD, archivedAt: null, e2eEnabled: false })).toBe(false)
    expect(isPostableStream({ type: StreamTypes.SYSTEM, archivedAt: null, e2eEnabled: false })).toBe(false)
  })

  it("rejects archived and E2E channels", () => {
    expect(isPostableStream({ type: StreamTypes.CHANNEL, archivedAt: "2025-01-01T00:00:00Z", e2eEnabled: false })).toBe(
      false
    )
    expect(isPostableStream({ type: StreamTypes.CHANNEL, archivedAt: null, e2eEnabled: true })).toBe(false)
  })
})
