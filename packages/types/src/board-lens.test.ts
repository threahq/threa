import { describe, expect, it } from "bun:test"
import { matchesBoardLens } from "./board-lens"
import type { BoardLens } from "./constants"
import type { BoardPost } from "./domain"

const NOW = Date.parse("2026-07-04T12:00:00.000Z")

function post(overrides: {
  status?: "active" | "stalled" | "resolved"
  hoursIdle?: number
  completenessScore?: number
  hasCapturedMemo?: boolean
  isMine?: boolean
}): BoardPost {
  const hoursIdle = overrides.hoursIdle ?? 0
  return {
    conversation: {
      id: "conv_1",
      status: overrides.status ?? "active",
      completenessScore: overrides.completenessScore ?? 1,
      lastActivityAt: new Date(NOW - hoursIdle * 3_600_000).toISOString(),
    },
    hasCapturedMemo: overrides.hasCapturedMemo ?? false,
    isMine: overrides.isMine ?? false,
  } as unknown as BoardPost
}

describe("matchesBoardLens", () => {
  it("all accepts everything — the default home never hides", () => {
    expect(matchesBoardLens(post({ status: "resolved", hasCapturedMemo: false }), "all")).toBe(true)
    expect(matchesBoardLens(post({ status: "stalled" }), "all")).toBe(true)
    expect(matchesBoardLens(post({ hoursIdle: 0 }), "all")).toBe(true)
  })

  it("decisions accepts only captured-memo posts", () => {
    expect(matchesBoardLens(post({ hasCapturedMemo: true }), "decisions")).toBe(true)
    expect(matchesBoardLens(post({ hasCapturedMemo: false }), "decisions")).toBe(false)
  })

  it("mine accepts only the viewer's own posts (server-precomputed isMine)", () => {
    expect(matchesBoardLens(post({ isMine: true }), "mine")).toBe(true)
    expect(matchesBoardLens(post({ isMine: false }), "mine")).toBe(false)
    // Mine narrows; it must not leak into the default home — `all` still takes an
    // isMine:false post.
    expect(matchesBoardLens(post({ isMine: false }), "all")).toBe(true)
  })

  it("a retired lens value still stored on a saved view degrades to `all`, never hides or throws", () => {
    for (const retired of ["active", "needs-resolution", "nonsense"] as unknown as BoardLens[]) {
      expect(matchesBoardLens(post({ status: "resolved", hasCapturedMemo: false, isMine: false }), retired)).toBe(true)
      expect(matchesBoardLens(post({ status: "stalled", hoursIdle: 99, completenessScore: 7 }), retired)).toBe(true)
    }
  })
})
