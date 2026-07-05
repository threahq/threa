import { describe, expect, it } from "bun:test"
import { matchesBoardLens } from "./board-lens"
import { BOARD_LENS_STALE_HOURS } from "./constants"
import type { BoardPost } from "./domain"

const NOW = Date.parse("2026-07-04T12:00:00.000Z")

function post(overrides: {
  status?: "active" | "stalled" | "resolved"
  hoursIdle?: number
  completenessScore?: number
  hasCapturedMemo?: boolean
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
  } as unknown as BoardPost
}

describe("matchesBoardLens", () => {
  it("all accepts everything — the default home never hides", () => {
    expect(matchesBoardLens(post({ status: "resolved", hasCapturedMemo: false }), "all", NOW)).toBe(true)
    expect(matchesBoardLens(post({ status: "stalled" }), "all", NOW)).toBe(true)
    expect(matchesBoardLens(post({ hoursIdle: 0 }), "all", NOW)).toBe(true)
  })

  it("active accepts only conversations still in motion", () => {
    expect(matchesBoardLens(post({ status: "active" }), "active", NOW)).toBe(true)
    expect(matchesBoardLens(post({ status: "stalled" }), "active", NOW)).toBe(false)
    expect(matchesBoardLens(post({ status: "resolved" }), "active", NOW)).toBe(false)
  })

  it("decisions accepts only captured-memo posts", () => {
    expect(matchesBoardLens(post({ hasCapturedMemo: true }), "decisions", NOW)).toBe(true)
    expect(matchesBoardLens(post({ hasCapturedMemo: false }), "decisions", NOW)).toBe(false)
  })

  it("needs-resolution accepts an explicitly stalled conversation regardless of age", () => {
    expect(
      matchesBoardLens(post({ status: "stalled", hoursIdle: 0, completenessScore: 7 }), "needs-resolution", NOW)
    ).toBe(true)
  })

  it("needs-resolution accepts a long-idle, still-incomplete conversation", () => {
    expect(
      matchesBoardLens(post({ hoursIdle: BOARD_LENS_STALE_HOURS + 1, completenessScore: 2 }), "needs-resolution", NOW)
    ).toBe(true)
  })

  it("needs-resolution rejects a fresh conversation even if incomplete", () => {
    expect(matchesBoardLens(post({ hoursIdle: 1, completenessScore: 1 }), "needs-resolution", NOW)).toBe(false)
  })

  it("needs-resolution rejects a long-idle but near-complete conversation", () => {
    expect(
      matchesBoardLens(post({ hoursIdle: BOARD_LENS_STALE_HOURS + 10, completenessScore: 7 }), "needs-resolution", NOW)
    ).toBe(false)
  })

  it("needs-resolution rejects a resolved conversation even when idle and incomplete", () => {
    expect(
      matchesBoardLens(
        post({ status: "resolved", hoursIdle: BOARD_LENS_STALE_HOURS + 5, completenessScore: 2 }),
        "needs-resolution",
        NOW
      )
    ).toBe(false)
  })
})
