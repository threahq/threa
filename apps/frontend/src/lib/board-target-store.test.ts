import { describe, it, expect, beforeEach } from "vitest"
import { readTargetMru, pushTargetMru, readDraftTarget, writeDraftTarget } from "./board-target-store"

const WS = "workspace_1"

beforeEach(() => {
  for (const key of [
    "board:post-target-mru:workspace_1",
    "board:post-target-mru:workspace_2",
    "board:new-post:target:workspace_1",
  ])
    localStorage.removeItem(key)
})

describe("board draft target", () => {
  it("returns empty when nothing is stored, round-trips a value, and clears on empty", () => {
    expect(readDraftTarget(WS)).toBe("")
    writeDraftTarget(WS, "stream_design")
    expect(readDraftTarget(WS)).toBe("stream_design")
    writeDraftTarget(WS, "")
    expect(readDraftTarget(WS)).toBe("")
  })
})

describe("board target MRU", () => {
  it("returns an empty list when nothing is stored", () => {
    expect(readTargetMru(WS)).toEqual([])
  })

  it("promotes newest to the front and dedups", () => {
    pushTargetMru(WS, "stream_a")
    pushTargetMru(WS, "stream_b")
    pushTargetMru(WS, "stream_a")
    expect(readTargetMru(WS)).toEqual(["stream_a", "stream_b"])
  })

  it("caps the list at 5", () => {
    for (const id of ["a", "b", "c", "d", "e", "f", "g"]) pushTargetMru(WS, `stream_${id}`)
    const mru = readTargetMru(WS)
    expect(mru).toHaveLength(5)
    expect(mru[0]).toBe("stream_g")
    expect(mru).not.toContain("stream_a")
  })

  it("ignores an empty value and scopes per workspace", () => {
    pushTargetMru(WS, "")
    pushTargetMru(WS, "stream_x")
    pushTargetMru("workspace_2", "stream_y")
    expect(readTargetMru(WS)).toEqual(["stream_x"])
    expect(readTargetMru("workspace_2")).toEqual(["stream_y"])
  })

  it("survives malformed stored JSON", () => {
    localStorage.setItem("board:post-target-mru:workspace_1", "{not json")
    expect(readTargetMru(WS)).toEqual([])
  })
})
