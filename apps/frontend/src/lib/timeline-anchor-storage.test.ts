import { describe, it, expect, beforeEach, vi, afterEach } from "vitest"
import { accountStorageKey } from "@/lib/account-storage"
import { workspaceScopedKey } from "@/lib/workspace-scoped-key"
import { saveTimelineAnchor, loadTimelineAnchor, clearTimelineAnchor } from "./timeline-anchor-storage"

const storageKey = () => accountStorageKey("timeline-anchors")!

describe("timeline-anchor-storage", () => {
  beforeEach(() => {
    localStorage.clear()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("round-trips an anchor per stream", () => {
    saveTimelineAnchor("ws_1", "stream_a", { targetId: "msg_1", offsetPx: -120 })
    saveTimelineAnchor("ws_1", "stream_b", { targetId: "evt_2", offsetPx: 8 })
    expect(loadTimelineAnchor("ws_1", "stream_a")).toEqual({ targetId: "msg_1", offsetPx: -120 })
    expect(loadTimelineAnchor("ws_1", "stream_b")).toEqual({ targetId: "evt_2", offsetPx: 8 })
    expect(loadTimelineAnchor("ws_1", "stream_c")).toBeNull()
  })

  it("clears a stream's anchor without touching the others", () => {
    saveTimelineAnchor("ws_1", "stream_a", { targetId: "msg_1", offsetPx: 0 })
    saveTimelineAnchor("ws_1", "stream_b", { targetId: "msg_2", offsetPx: 0 })
    clearTimelineAnchor("ws_1", "stream_a")
    expect(loadTimelineAnchor("ws_1", "stream_a")).toBeNull()
    expect(loadTimelineAnchor("ws_1", "stream_b")).toEqual({ targetId: "msg_2", offsetPx: 0 })
  })

  it("should keep an anchor invisible to another workspace when both hold the same stream id", () => {
    saveTimelineAnchor("ws_a", "stream_shared", { targetId: "msg_a", offsetPx: 3 })
    saveTimelineAnchor("ws_b", "stream_shared", { targetId: "msg_b", offsetPx: 9 })
    saveTimelineAnchor("ws_a", "stream_only_a", { targetId: "msg_c", offsetPx: 1 })

    expect({
      onlyA: loadTimelineAnchor("ws_b", "stream_only_a"),
      sharedA: loadTimelineAnchor("ws_a", "stream_shared"),
      sharedB: loadTimelineAnchor("ws_b", "stream_shared"),
    }).toEqual({
      onlyA: null,
      sharedA: { targetId: "msg_a", offsetPx: 3 },
      sharedB: { targetId: "msg_b", offsetPx: 9 },
    })

    clearTimelineAnchor("ws_b", "stream_shared")

    expect({
      sharedA: loadTimelineAnchor("ws_a", "stream_shared"),
      sharedB: loadTimelineAnchor("ws_b", "stream_shared"),
    }).toEqual({ sharedA: { targetId: "msg_a", offsetPx: 3 }, sharedB: null })
  })

  it("expires anchors past the TTL", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-08-12T10:00:00Z"))
    saveTimelineAnchor("ws_1", "stream_a", { targetId: "msg_1", offsetPx: 0 })
    vi.setSystemTime(new Date("2026-08-12T21:00:00Z"))
    expect(loadTimelineAnchor("ws_1", "stream_a")).toEqual({ targetId: "msg_1", offsetPx: 0 })
    vi.setSystemTime(new Date("2026-08-13T10:00:01Z"))
    expect(loadTimelineAnchor("ws_1", "stream_a")).toBeNull()
  })

  it("evicts the oldest entries past the cap", () => {
    vi.useFakeTimers()
    const base = new Date("2026-08-12T10:00:00Z").getTime()
    for (let i = 0; i < 51; i++) {
      vi.setSystemTime(base + i * 1000)
      saveTimelineAnchor("ws_1", `stream_${i}`, { targetId: `msg_${i}`, offsetPx: 0 })
    }
    expect(loadTimelineAnchor("ws_1", "stream_0")).toBeNull()
    expect(loadTimelineAnchor("ws_1", "stream_1")).toEqual({ targetId: "msg_1", offsetPx: 0 })
    expect(loadTimelineAnchor("ws_1", "stream_50")).toEqual({ targetId: "msg_50", offsetPx: 0 })
  })

  it("survives corrupt storage", () => {
    localStorage.setItem(storageKey(), "{not json")
    expect(loadTimelineAnchor("ws_1", "stream_a")).toBeNull()
    saveTimelineAnchor("ws_1", "stream_a", { targetId: "msg_1", offsetPx: 4 })
    expect(loadTimelineAnchor("ws_1", "stream_a")).toEqual({ targetId: "msg_1", offsetPx: 4 })
    localStorage.setItem(
      storageKey(),
      JSON.stringify({ [workspaceScopedKey("ws_1", "stream_b")]: { targetId: 7, offsetPx: "x", at: "y" } })
    )
    expect(loadTimelineAnchor("ws_1", "stream_b")).toBeNull()
  })
})
