import { describe, it, expect, beforeEach, vi, afterEach } from "vitest"
import { saveTimelineAnchor, loadTimelineAnchor, clearTimelineAnchor } from "./timeline-anchor-storage"

const STORAGE_KEY = "threa:timeline-anchors"

describe("timeline-anchor-storage", () => {
  beforeEach(() => {
    localStorage.clear()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("round-trips an anchor per stream", () => {
    saveTimelineAnchor("stream_a", { targetId: "msg_1", offsetPx: -120 })
    saveTimelineAnchor("stream_b", { targetId: "evt_2", offsetPx: 8 })
    expect(loadTimelineAnchor("stream_a")).toEqual({ targetId: "msg_1", offsetPx: -120 })
    expect(loadTimelineAnchor("stream_b")).toEqual({ targetId: "evt_2", offsetPx: 8 })
    expect(loadTimelineAnchor("stream_c")).toBeNull()
  })

  it("clears a stream's anchor without touching the others", () => {
    saveTimelineAnchor("stream_a", { targetId: "msg_1", offsetPx: 0 })
    saveTimelineAnchor("stream_b", { targetId: "msg_2", offsetPx: 0 })
    clearTimelineAnchor("stream_a")
    expect(loadTimelineAnchor("stream_a")).toBeNull()
    expect(loadTimelineAnchor("stream_b")).toEqual({ targetId: "msg_2", offsetPx: 0 })
  })

  it("expires anchors past the TTL", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-08-12T10:00:00Z"))
    saveTimelineAnchor("stream_a", { targetId: "msg_1", offsetPx: 0 })
    vi.setSystemTime(new Date("2026-08-12T21:00:00Z"))
    expect(loadTimelineAnchor("stream_a")).toEqual({ targetId: "msg_1", offsetPx: 0 })
    vi.setSystemTime(new Date("2026-08-13T10:00:01Z"))
    expect(loadTimelineAnchor("stream_a")).toBeNull()
  })

  it("evicts the oldest entries past the cap", () => {
    vi.useFakeTimers()
    const base = new Date("2026-08-12T10:00:00Z").getTime()
    for (let i = 0; i < 51; i++) {
      vi.setSystemTime(base + i * 1000)
      saveTimelineAnchor(`stream_${i}`, { targetId: `msg_${i}`, offsetPx: 0 })
    }
    expect(loadTimelineAnchor("stream_0")).toBeNull()
    expect(loadTimelineAnchor("stream_1")).toEqual({ targetId: "msg_1", offsetPx: 0 })
    expect(loadTimelineAnchor("stream_50")).toEqual({ targetId: "msg_50", offsetPx: 0 })
  })

  it("survives corrupt storage", () => {
    localStorage.setItem(STORAGE_KEY, "{not json")
    expect(loadTimelineAnchor("stream_a")).toBeNull()
    saveTimelineAnchor("stream_a", { targetId: "msg_1", offsetPx: 4 })
    expect(loadTimelineAnchor("stream_a")).toEqual({ targetId: "msg_1", offsetPx: 4 })
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ stream_b: { targetId: 7, offsetPx: "x", at: "y" } }))
    expect(loadTimelineAnchor("stream_b")).toBeNull()
  })
})
