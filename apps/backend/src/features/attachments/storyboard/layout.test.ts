import { describe, expect, test } from "bun:test"
import { storyboardLayout } from "./layout"

describe("storyboardLayout", () => {
  test("should use one tile for a clip shorter than one interval", () => {
    expect(storyboardLayout(200)).toEqual({ tileCount: 1, intervalMs: 200, columns: 1, rows: 1 })
  })

  test("should cap a long video at 100 tiles in a 10x10 grid", () => {
    expect(storyboardLayout(3_600_000)).toEqual({ tileCount: 100, intervalMs: 36_000, columns: 10, rows: 10 })
  })

  test("should leave the last row partly filled", () => {
    expect(storyboardLayout(12_000)).toEqual({ tileCount: 24, intervalMs: 500, columns: 10, rows: 3 })
  })
})
