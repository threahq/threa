import { describe, expect, test } from "bun:test"
import { diffFindings } from "./render"

describe("diffFindings", () => {
  test("reports new and changed findings as added, vanished ones as resolved", () => {
    const prev = [
      { level: "warn" as const, id: "a", message: "a v1" },
      { level: "warn" as const, id: "b", message: "b" },
    ]
    const next = [
      { level: "warn" as const, id: "a", message: "a v2" },
      { level: "fail" as const, id: "c", message: "c" },
    ]
    const diff = diffFindings(prev, next)
    expect(diff.added).toEqual([
      { level: "warn", id: "a", message: "a v2" },
      { level: "fail", id: "c", message: "c" },
    ])
    expect(diff.resolved).toEqual([{ level: "warn", id: "b", message: "b" }])
  })
})
